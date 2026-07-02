#!/usr/bin/env bash
# SQLite proxy.db → PostgreSQL 一键迁移
#
# 用法:
#   ./scripts/migrate-sqlite-to-pg.sh                    # 默认 server/proxy.db
#   ./scripts/migrate-sqlite-to-pg.sh /path/to/proxy.db
#   ./scripts/migrate-sqlite-to-pg.sh --local            # 本地 Python 执行（需已安装依赖）
#   ./scripts/migrate-sqlite-to-pg.sh --skip-init        # 透传给 migrate_sqlite_to_pg.py
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
SQLITE_PATH=""
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --local) MODE="local" ;;
    --docker) MODE="docker" ;;
    --help|-h)
      sed -n '2,10p' "$0" | sed 's/^# \?//'
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

SQLITE_PATH="${SQLITE_PATH:-$ROOT/server/proxy.db}"

if [[ ! -f "$SQLITE_PATH" ]]; then
  echo "错误: SQLite 文件不存在: $SQLITE_PATH" >&2
  exit 1
fi

echo "源库: $SQLITE_PATH"
echo "目标: $DATABASE_URL"
echo ""

if [[ "$MODE" == "local" ]]; then
  # 本地直连 PG（POSTGRES_HOST 默认改 localhost）
  export DATABASE_URL="${DATABASE_URL/@postgres:/@localhost:}"
  export SQLITE_PATH="$SQLITE_PATH"
  exec python3 "$ROOT/server/migrate_sqlite_to_pg.py" \
    --sqlite "$SQLITE_PATH" \
    --truncate \
    "${EXTRA_ARGS[@]}"
fi

# Docker：仅需 postgres 运行，用 proxy 镜像执行迁移脚本
docker compose up -d postgres

docker compose run --rm \
  -v "$SQLITE_PATH:/backup/proxy.db:ro" \
  -e "DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
  proxy python migrate_sqlite_to_pg.py \
    --sqlite /backup/proxy.db \
    --truncate \
    "${EXTRA_ARGS[@]}"

echo ""
echo "迁移完成。启动服务: docker compose up -d"
