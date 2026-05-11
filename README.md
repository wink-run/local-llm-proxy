# Local LLM Proxy

[中文文档](./README.zh-CN.md) · [Source](https://github.com/wink-run/local-llm-proxy)

```bash
git clone git@github.com:wink-run/local-llm-proxy.git
```

## What it does

**Local LLM Proxy** bridges locally-hosted or LAN-restricted LLMs to the public internet — without opening any inbound ports.

Each participating machine runs a lightweight `llm-agent` that **dials out** over WebSocket to a VPS. The VPS exposes a unified **OpenAI-compatible HTTP API**. Clients send requests to the VPS; the VPS routes them to the right worker; the worker forwards them to its local LLM and streams the response back.

**Key benefits**

- Models running on private LANs (Ollama, self-hosted inference, internal API endpoints) become reachable from anywhere.
- Multiple workers with different models pool together — the VPS load-balances automatically.
- No inbound firewall rules, no NAT traversal tricks needed; workers initiate all connections.
- Resembles a **P2P compute pool**: contributors run workers voluntarily and earn credits; consumers spend credits to call the API.

**Privacy & control**

- **Upstream API keys never leave your machine.** Any `--llm-token` you configure in the agent stays in a local config file (`~/.llm-agent/config.json`) and is only used for the direct agent→LLM connection. The proxy server never sees or stores it.
- **Stop contributing any time.** Kill the agent process (`Ctrl+C`) and the worker immediately drops off the pool — no "unregister" step needed.

Full protocol and architecture details: [DESIGN.md](./DESIGN.md)

---

## Deployment

### 1 · VPS — Docker Compose

Copy and edit the environment file, then start:

```bash
cp .env.example .env
# set WORKER_TOKEN, ADMIN_KEY, and optionally REQUEST_TIMEOUT
docker compose up -d --build
```

Default external port: **8000** (see `docker-compose.yml`).  
SQLite database lives in the `db_data` Docker volume.

| Variable | Description |
|---|---|
| `WORKER_TOKEN` | Shared secret that agents must supply when registering |
| `ADMIN_KEY` | Password for the admin dashboard and admin API |
| `REQUEST_TIMEOUT` | Per-request forwarding timeout in seconds (default `120`) |

For production, put the VPS behind an Nginx reverse proxy with HTTPS and point workers at `wss://your-domain/ws/worker`.

### 2 · Local agent (LAN machine)

**Option A — run from source**

```bash
cd agent
pip install -r requirements.txt

python agent.py register \
  --server "ws://YOUR_VPS:8000/ws/worker" \
  --token  "same as WORKER_TOKEN" \
  --models "model-a,model-b" \
  --llm-url "http://localhost:11434" \
  --name   "my-machine"

python agent.py start
```

Add `--llm-token` if your local LLM requires a bearer token.  
Config is saved to `~/.llm-agent/config.json`; subsequent runs just need `python agent.py start`.

**Option B — single-file binary** (build on the target OS):

```bash
cd agent
chmod +x build.sh && ./build.sh
# use ./dist/llm-agent instead of python agent.py
```

Pre-built binaries (if available) can be downloaded from the `/` landing page of a running instance.

The agent forwards to the local LLM's **`POST /v1/chat/completions`** endpoint.

---

## Usage

After deploying, open `http://YOUR_VPS:8000` in a browser to see the landing page.

### Admin dashboard

1. Go to `http://YOUR_VPS:8000/admin/ui`
2. Log in with `ADMIN_KEY`
3. Create API keys for users, configure models and credit rates

### User portal

Go to `http://YOUR_VPS:8000/app` to register, view your balance, manage API keys, and submit credit top-up requests.

### OpenAI-compatible API

| Endpoint | Method | Description |
|---|---|---|
| `/v1/models` | GET | List online models |
| `/v1/chat/completions` | POST | Chat completions (streaming supported) |

All endpoints require `Authorization: Bearer <USER_API_KEY>`.

**Example**

```bash
curl -sS "http://YOUR_VPS:8000/v1/chat/completions" \
  -H "Authorization: Bearer USER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

Any OpenAI-compatible client that supports a custom `base_url` works — set it to `http://YOUR_VPS:8000/v1`.

---

## Local development (no Docker)

```bash
cd server
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

Provide `.env` variables or export them manually before starting.

---

## Disclaimer

This project is for **educational and research purposes only**. Users are responsible for complying with applicable laws, regulations, and upstream service terms. The authors assume no liability for any consequences arising from deployment, token sharing, or request forwarding.
