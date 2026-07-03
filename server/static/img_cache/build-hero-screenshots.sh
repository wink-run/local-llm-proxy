#!/usr/bin/env bash
# 将 PNG 源图严格按文件名转为 landing hero 用 webp。
# 命名约定（与 landing.html data-tab 一一对应）：
#   {key}.png      → {key}.webp      （中文截图，tab 高亮须与 key 对应）
#   {key}_en.png   → {key}_en.webp   （英文截图）
# 输出尺寸固定 1600×1269，等比缩放后留白（不裁剪），避免 tab 与内容被裁切。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_W=1600
TARGET_H=1269
QUALITY=85
PAD_COLOR=0xF5F2F0

# 顺序与 landing #tb-tabs 一致
KEYS=(dashboard gateway provider contribute circle world device trace)

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1" >&2; exit 1; }
}
need_cmd ffmpeg
need_cmd cwebp

missing=()
for key in "${KEYS[@]}"; do
  for suffix in "" "_en"; do
    png="${DIR}/${key}${suffix}.png"
    [[ -f "$png" ]] || missing+=("${key}${suffix}.png")
  done
done
if ((${#missing[@]} > 0)); then
  echo "以下 PNG 源图缺失，请放入 ${DIR}/ 后重试：" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

for key in "${KEYS[@]}"; do
  for suffix in "" "_en"; do
    png="${DIR}/${key}${suffix}.png"
    webp="${DIR}/${key}${suffix}.webp"
    tmp="$(mktemp /tmp/tb_${key}${suffix}.XXXXXX.png)"
    # 等比缩放到画布内，居中铺底色，保证完整画面
    ffmpeg -y -loglevel error -i "$png" \
      -vf "scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=${PAD_COLOR}" \
      "$tmp"
    cwebp -q "$QUALITY" "$tmp" -o "$webp"
    rm -f "$tmp"
    w=$(sips -g pixelWidth "$webp" 2>/dev/null | awk '/pixelWidth/{print $2}')
    h=$(sips -g pixelHeight "$webp" 2>/dev/null | awk '/pixelHeight/{print $2}')
    echo "OK ${key}${suffix}.png → ${key}${suffix}.webp (${w}x${h})"
  done
done

echo "全部 ${#KEYS[@]} 组截图已生成。"
