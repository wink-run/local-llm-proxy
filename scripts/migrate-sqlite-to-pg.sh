#!/usr/bin/env bash
# SQLite proxy.db → PostgreSQL 一键迁移
#
# 用法:
#   ./scripts/migrate-sqlite-to-pg.sh --from-compose   # 从 docker compose 卷迁移（推荐）
#   ./scripts/migrate-sqlite-to-pg.sh                  # 默认 server/proxy.db
#   ./scripts/migrate-sqlite-to-pg.sh /path/to/proxy.db
#   ./scripts/migrate-sqlite-to-pg.sh --local          # 本地 Python 执行（需已安装依赖）
#   ./scripts/migrate-sqlite-to-pg.sh --skip-init      # 透传给 migrate_sqlite_to_pg.py
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 加载 .env（若存在）
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-root}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-wink123}"
POSTGRES_DB="${POSTGRES_DB:-tokenbank}"
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}}"

MODE="docker"
FROM_COMPOSE=0
SQLITE_PATH=""
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --local) MODE="local" ;;
    --docker) MODE="docker" ;;
    --from-compose) FROM_COMPOSE=1 ;;
    --help|-h)
      sed -n '2,11p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    --*)
      EXTRA_ARGS+=("$arg")
      ;;
    *)
      if [[ -z "$SQLITE_PATH" ]]; then
        SQLITE_PATH="$arg"
      else
        EXTRA_ARGS+=("$arg")
      fi
      ;;
  esac
done

# 旧版 docker compose 把 proxy.db 放在 /app/data/proxy.db（卷名 app_data 或 db_data）
_compose_project_name() {
  local name
  name="$(docker compose config --format '{{.Name}}' 2>/dev/null || true)"
  if [[ -z "$name" ]]; then
    name="$(basename "$ROOT")"
  fi
  echo "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g'
}

_volume_has_proxy_db() {
  local vol="$1"
  docker run --rm -v "${vol}:/data:ro" alpine sh -c 'test -f /data/proxy.db' 2>/dev/null
}

_find_compose_sqlite_volume() {
  local project vol
  project="$(_compose_project_name)"

  # 当前 compose 卷 + 旧版 db_data 卷
  for vol in "${project}_app_data" "${project}_db_data" "app_data" "db_data"; do
    if docker volume inspect "$vol" &>/dev/null && _volume_has_proxy_db "$vol"; then
      echo "$vol"
      return 0
    fi
  done

  # 兜底：任意含 db_data / app_data 且含 proxy.db 的卷
  while IFS= read -r vol; do
    if _volume_has_proxy_db "$vol"; then
      echo "$vol"
      return 0
    fi
  done < <(docker volume ls -q | grep -E '(app_data|db_data)$' || true)

  return 1
}

_run_migration_in_compose() {
  local sqlite_in_container="$1"
  shift

  docker compose up -d postgres

  # 镜像内代码是 build 时 COPY 的快照，git pull 后须 rebuild；同时挂载 server 确保用最新脚本
  echo "构建 proxy 镜像…"
  docker compose build proxy

  docker compose run --rm \
    -v "$ROOT/server:/app:ro" \
    -e "DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
    "$@" \
    proxy python migrate_sqlite_to_pg.py \
      --sqlite "$sqlite_in_container" \
      --truncate \
      "${EXTRA_ARGS[@]}"
}

if [[ "$FROM_COMPOSE" == "1" ]]; then
  VOL="$(_find_compose_sqlite_volume || true)"
  if [[ -z "$VOL" ]]; then
    echo "错误: 未在 docker 卷中找到 /data/proxy.db" >&2
    echo "请确认曾用 docker compose 跑过 SQLite 版，并检查卷:" >&2
    docker volume ls | grep -E 'app_data|db_data' || true
    exit 1
  fi

  echo "源卷: $VOL  →  /data/proxy.db"
  echo "目标: postgresql://${POSTGRES_USER}:***@postgres:5432/${POSTGRES_DB}"
  echo ""

  _run_migration_in_compose "/data/proxy.db" -v "${VOL}:/data:ro"
  echo ""
  echo "迁移完成。启动服务: docker compose up -d"
  exit 0
fi

SQLITE_PATH="${SQLITE_PATH:-$ROOT/server/proxy.db}"

if [[ ! -f "$SQLITE_PATH" ]]; then
  echo "错误: SQLite 文件不存在: $SQLITE_PATH" >&2
  echo "若数据在 docker compose 卷中，请使用: $0 --from-compose" >&2
  exit 1
fi

echo "源库: $SQLITE_PATH"
echo "目标: $DATABASE_URL"
echo ""

if [[ "$MODE" == "local" ]]; then
  export DATABASE_URL="${DATABASE_URL/@postgres:/@localhost:}"
  export SQLITE_PATH="$SQLITE_PATH"
  exec python3 "$ROOT/server/migrate_sqlite_to_pg.py" \
    --sqlite "$SQLITE_PATH" \
    --truncate \
    "${EXTRA_ARGS[@]}"
fi

_run_migration_in_compose "/backup/proxy.db" -v "$SQLITE_PATH:/backup/proxy.db:ro"

echo ""
echo "迁移完成。启动服务: docker compose up -d"
