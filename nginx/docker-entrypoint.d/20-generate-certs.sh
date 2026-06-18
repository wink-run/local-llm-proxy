#!/bin/sh
# 证书缺失时生成自签名 PEM（本地 / 开发用；生产请替换为正式证书）
set -e

CERT_DIR=/etc/nginx/certs
mkdir -p "$CERT_DIR"

if ! command -v openssl >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache openssl >/dev/null 2>&1 || true
  fi
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "[nginx] openssl not available, cannot generate dev certs"
  exit 0
fi

gen_self_signed() {
  cert_file=$1
  key_file=$2
  cn=$3
  sans=$4

  if [ -f "$cert_file" ] && [ -f "$key_file" ]; then
    return 0
  fi

  echo "[nginx] missing $cert_file — generating self-signed cert for $cn (dev only)"
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$key_file" \
    -out "$cert_file" \
    -subj "/CN=$cn" \
    -addext "subjectAltName=$sans"
}

# Token Bank 后端 HTTPS（profile: https）
if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
  domain="${DOMAIN:-tokenbank.example.com}"
  gen_self_signed \
    "$CERT_DIR/fullchain.pem" \
    "$CERT_DIR/privkey.pem" \
    "$domain" \
    "DNS:$domain,DNS:localhost,IP:127.0.0.1"
fi

# CLI Gateway HTTPS（profile: gateway-https）
if [ ! -f "$CERT_DIR/gateway-fullchain.pem" ] || [ ! -f "$CERT_DIR/gateway-privkey.pem" ]; then
  gw="${GATEWAY_DOMAIN:-gateway.example.com}"
  gen_self_signed \
    "$CERT_DIR/gateway-fullchain.pem" \
    "$CERT_DIR/gateway-privkey.pem" \
    "$gw" \
    "DNS:$gw,DNS:llm.$gw,DNS:localhost,IP:127.0.0.1"
fi
