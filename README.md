# Local LLM Proxy

**P2P · OpenAI-compatible · Outbound WebSocket** — turn idle token/compute into **universal credits** you can spend across models and time.

[中文文档](./README.zh-CN.md)

<!--
 · [Source](https://github.com/wink-run/local-llm-proxy)

```bash
git clone git@github.com:wink-run/local-llm-proxy.git
```
-->

## What it does

**Local LLM Proxy** bridges locally-hosted or LAN-restricted LLMs to the public internet — without opening any inbound ports. Contributors share voluntary quota (Ollama, intranet gateways, or upstream API paths); consumers call a single OpenAI-compatible endpoint using credits — **rates and settlement rules are published** on the landing page and in the admin UI.

Each participating machine runs a lightweight `llm-agent` that **dials out** over WebSocket to a VPS. The VPS exposes a unified **OpenAI-compatible HTTP API**. External clients use a **Bearer user API key**; workers authenticate with the account **Worker key** (`wk-…`, shown in the User Portal — stored per user in the database). **Upstream LLM credentials are never persisted by the proxy.** Clients send requests to the VPS; the VPS routes them to the right worker; the worker forwards them to its local LLM and streams the response back.

**Principles** (same as the landing page)

- **All for one, one for all** — peer surplus sharing; credits work across models and time.
- **Neutral & transparent** — breaks the traditional relay black box; multi-party dynamics with published rules; code is open source.
- **Affordable for buyers** — calling via credits often beats buying upstream API alone for the same model tier.

**Two ways credits add value**

- **Model arbitrage** — contribute quota from models you have, earn credits, spend on models you don’t (e.g. domestic → overseas, open → premium). Workers are scored by latency, uptime, and success rate; higher quality earns a **quality multiplier** on contributed credits.
- **Time arbitrage** — bank today’s surplus (month-end API leftovers, idle desktops) as credits for later (e.g. after your machine is off, or next month).

**Key benefits**

- Models on private LANs become reachable from anywhere; **no inbound firewall rules** — workers initiate all connections.
- **Multi-node pool** — different models and workers aggregate behind one `/v1` API.
- **P2P-style economy** — voluntary workers earn credits; API callers spend credits.

**Credit economy** (summary; live rates on `/` and `/admin/ui`)

- **Earn (settles every 5 minutes):**  
  `credits = (output_tokens / 1000) × model_contribute_rate × quality_multiplier`  
  Quality ≈ `0.4×uptime + 0.4×latency + 0.2×stability`, clamped to **0.5–1.5×**.
- **Spend (per API call):**  
  `cost = ((prompt + completion tokens) / 1000) × model_consume_rate`  
  By design, **contribute rate > consume rate** so long-term contributors are rewarded.

**Privacy & control**

- **Upstream API keys never leave your machine.** `--llm-token` stays in local agent config (`~/.llm-agent/config.json`) and is only used for the agent→LLM hop. Registration sends **worker_key**, node name, and model list — not your upstream key.
- **User API keys** for calling the VPS are issued from the admin/user portal and stored server-side — they are **separate** from upstream keys.
- **Stop contributing any time.** Kill the agent (`Ctrl+C`) or go offline — no server-side “unbind” step.

Full protocol and architecture details: [DESIGN.md](./DESIGN.md)

---

## Deployment

### 1 · VPS — Docker Compose

Copy and edit the environment file, then start:

```bash
cp .env.example .env
# set ADMIN_KEY, and optionally REQUEST_TIMEOUT
docker compose up -d --build
```

Default external port: **8000** (see `docker-compose.yml`).  
SQLite database lives in the `db_data` Docker volume.

| Variable | Description |
|---|---|
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
  --worker-key "wk-...from-user-portal" \
  --models "model-a,model-b" \
  --llm-url "http://localhost:11434" \
  --name   "my-machine"

python agent.py start
```

Copy **`--worker-key`** from the User Portal (`/app`); it is the sole credential for worker WebSocket registration.  
Add `--llm-token` if your local LLM requires a bearer token.  
Config is saved to `~/.llm-agent/config.json`; subsequent runs just need `python agent.py start`.

**Option B — single-file binary** (build on the target OS):

```bash
cd agent
chmod +x build.sh && ./build.sh
# use ./dist/llm-agent instead of python agent.py
```

Pre-built binaries (if available) are listed under **Download Agent** on the `/` landing page (`static/downloads/`; build via `agent/build.sh`).

The agent forwards to the local LLM's **`POST /v1/chat/completions`** endpoint.

---

## Usage

After deploying, open `http://YOUR_VPS:8000` in a browser to see the landing page (model rates, credit examples, and agent downloads).

### Live operations dashboard

Open `http://YOUR_VPS:8000/wall` for the **live operations wall** (aggregated runtime view).

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
