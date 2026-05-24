FROM python:3.11-slim

# 容器内使用东八区（中国标准时间），便于日志与排障
ENV TZ=Asia/Shanghai
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 共享 requirements 在 server/ 根（build context = ./server）
COPY requirements.txt .
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

# 只拷 VPS 端代码（不含 local/ 本地网关代码，镜像更小）
COPY vps/ ./vps/

WORKDIR /app/vps

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--ws-max-size", "104857600"]
