#!/usr/bin/env bash
# 在宿主机预生成 nginx/certs 下的自签名证书（与容器 entrypoint 逻辑一致）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT/nginx/certs"
DOMAIN="${DOMAIN:-tokenbank.example.com}"
GATEWAY_DOMAIN="${GATEWAY_DOMAIN:-gateway.example.com}"

mkdir -p "$CERT_DIR"

gen() {
  local cert=$1 key=$2 cn=$3 sans=$4
  if [[ -f "$cert" && -f "$key" ]]; then
    echo "skip (exists): $cert"
    return
  fi
  echo "generate: $cert ($cn)"
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$key" -out "$cert" \
    -subj "/CN=$cn" \
    -addext "subjectAltName=$sans"
}

gen "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem" "$DOMAIN" \
  "DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1"

gen "$CERT_DIR/gateway-fullchain.pem" "$CERT_DIR/gateway-privkey.pem" "$GATEWAY_DOMAIN" \
  "DNS:$GATEWAY_DOMAIN,DNS:llm.$GATEWAY_DOMAIN,DNS:localhost,IP:127.0.0.1"

echo "done — certs in nginx/certs/ (gitignored)"
