#!/usr/bin/env bash
# PNG → landing hero webp（1600×1269）
# 规则：仅缩小过大图片；原始尺寸不足时不放大，居中铺底色填充。
# 命名与 landing.html data-tab 一一对应：{key}.png / {key}_en.png
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_W=1600
TARGET_H=1269
QUALITY=85
PAD_COLOR=0xF5F2F0

KEYS=(dashboard gateway provider contribute circle world device trace)

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1" >&2; exit 1; }
}
need_cmd ffmpeg
need_cmd cwebp
need_cmd sips

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
    src_w=$(sips -g pixelWidth "$png" 2>/dev/null | awk '/pixelWidth/{print $2}')
    src_h=$(sips -g pixelHeight "$png" 2>/dev/null | awk '/pixelHeight/{print $2}')
    tmp="$(mktemp /tmp/tb_${key}${suffix}.XXXXXX.png)"

    # decrease：只缩小不放大；pad：不足处用背景色填充
    ffmpeg -y -loglevel error -i "$png" \
      -vf "scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=${PAD_COLOR}" \
      "$tmp"
    cwebp -q "$QUALITY" "$tmp" -o "$webp"
    rm -f "$tmp"

    out_w=$(sips -g pixelWidth "$webp" 2>/dev/null | awk '/pixelWidth/{print $2}')
    out_h=$(sips -g pixelHeight "$webp" 2>/dev/null | awk '/pixelHeight/{print $2}')
    scaled=$([[ "$src_w" -le $TARGET_W && "$src_h" -le $TARGET_H ]] && echo "原尺寸+填充" || echo "缩小+填充")
    echo "OK ${key}${suffix}.png (${src_w}x${src_h}) → ${key}${suffix}.webp (${out_w}x${out_h}, ${scaled})"
  done
done

echo "全部 ${#KEYS[@]} 组截图已生成。"
