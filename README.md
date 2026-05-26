# Token Bank — Local LLM Gateway

**P2P Credit Network · OpenAI-Compatible · Three Deployment Modes** — turn local models and idle API quota into universal credits spendable across models and time.

[中文文档](./README.zh-CN.md) · [Architecture](./DESIGN.md) · [Download Latest](https://github.com/wink-run/local-llm-proxy/releases/latest)

---

## What it does

**Token Bank** runs a lightweight HTTP gateway on your machine (or server) that exposes a single **OpenAI-compatible `/v1` endpoint** and intelligently routes requests to:

| Source | Description |
|---|---|
| **Local models** | Ollama, LM Studio, or any local inference server |
| **Free tier** | Groq, GitHub Models, and other rate-limited free APIs |
| **P2P network** | Compute contributed by other users, paid with credits |
| **Paid APIs** | OpenAI, Anthropic, etc. — fallback when credits run out |

The gateway automatically switches between sources based on priority and credit balance. Callers only need one local endpoint — no need to know which backend served the request.

---

## Three ways to deploy

### 🖥 Desktop App (recommended)

Download the installer for your platform from [Releases](https://github.com/wink-run/local-llm-proxy/releases/latest):

- **macOS** — `.dmg`, double-click to install, lives in the system tray, auto-updates
- **Windows** — `.exe` NSIS installer, auto-updates

Open the app, complete account setup, and you're ready.

---

### 💻 CLI Mode (Linux / servers)

```bash
git clone https://github.com/wink-run/local-llm-proxy.git
cd local-llm-proxy/client

# Install dependencies (first time only)
npm install

# Start the gateway
node cli/gateway.js start
```

Once running:
- **Gateway** `:11430` — accepts LLM requests (`OPENAI_BASE_URL=http://localhost:11430/v1`)
- **Web UI** `:11431` — open `http://localhost:11431` in a browser to configure and view stats

Management commands:

```bash
node cli/gateway.js status    # Show gateway status
node cli/gateway.js restart   # Hot-restart
node cli/gateway.js keys      # List local API keys
```

---

### 🐳 Docker (containerised)

```bash
git clone https://github.com/wink-run/local-llm-proxy.git
cd local-llm-proxy

# Create config
mkdir -p gateway-data
cat > gateway-data/local-config.json << 'EOF'
{
  "cloud_config": {
    "url": "http://YOUR_BACKEND:8000",
    "token": "YOUR_P2P_KEY"
  },
  "scene_routes": [],
  "local_keys": []
}
EOF

# Start gateway only
docker compose up gateway -d

# Or start everything (backend + gateway)
docker compose up -d
```

| Port | Purpose |
|---|---|
| `11430` | OpenAI-compatible gateway (`OPENAI_BASE_URL`) |
| `11431` | Web UI and admin API |

Config is persisted in `./gateway-data/` — survives container restarts.

---

## Connecting any OpenAI client

```bash
export OPENAI_BASE_URL=http://localhost:11430/v1
export OPENAI_API_KEY=your-local-key   # create in the Web UI

# Quick test
curl http://localhost:11430/v1/chat/completions \
  -H "Authorization: Bearer your-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

Works with any OpenAI-compatible client: Claude Code, Continue, Cursor, Open WebUI, LangChain, and more.

---

## Features

### Smart routing
- Automatic source switching by priority (local → free tier → P2P → paid)
- Scene routes: bind different supply strategies to different model keys
- Gateway log: records every call's route, latency, and status

### P2P credit network
- Contribute local compute to earn credits; spend credits on models you don't have
- Daily check-in and spin wheel for bonus credits
- Full transaction history and real-time balance

### Multi-device management
- Unified view of all your devices (desktop + CLI) under one account
- Per-device stats: today's calls, error rate, active providers
- Real-time online status via heartbeat, auto-reconnect on disconnect

### Local key management
- Local API keys stored on-device — never uploaded to the cloud
- Bind keys to specific scene routes
- One-click scan of existing LLM environment variables and config files

---

## Architecture

```
Caller (Claude Code / Cursor / ...)
        │
        ▼ OpenAI API  :11430
┌─────────────────────────────┐
│     Local Gateway           │
│  Scene routing · Balancing  │
│  Logging · Stats            │
└────────┬──────────┬──────────┘
         │          │
    Local models  Cloud backend :8000
  (Ollama, etc.)  ┌──────────────┐
                  │  Token Bank  │
                  │  Credits     │
                  │  P2P routing │
                  └──────────────┘
                       │
                 P2P worker network
             (compute nodes from other users)
```

---

## Backend deployment (optional)

To run your own private P2P network:

```bash
cp .env.example .env
# Set ADMIN_KEY and other variables
docker compose up proxy -d
```

| Variable | Description |
|---|---|
| `ADMIN_KEY` | Admin dashboard password |
| `REQUEST_TIMEOUT` | Per-request forwarding timeout in seconds (default `120`) |

Admin dashboard: `http://YOUR_VPS:8000/admin/ui`  
User portal: `http://YOUR_VPS:8000/app`  
OpenAI API: `http://YOUR_VPS:8000/v1`

---

## Contributing compute (Worker)

```bash
cd agent
pip install -r requirements.txt

python agent.py register \
  --server "ws://YOUR_VPS:8000/ws/worker" \
  --worker-key "wk-... from the user portal" \
  --models "llama3,qwen2" \
  --llm-url "http://localhost:11434" \
  --name   "my-machine"

python agent.py start
```

**Upstream API keys never leave your machine.** `--llm-token` is stored only in `~/.llm-agent/config.json`; registration only sends the worker key and model list.

---

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).  
Redistribution and derivative works must retain the NOTICE and credit the source:  
**Token Bank · https://github.com/wink-run/local-llm-proxy**

---

## Disclaimer

This project is for educational and research purposes only. Users are responsible for complying with applicable laws, regulations, and upstream service terms. The authors assume no liability for any consequences arising from deployment, compute sharing, or request forwarding.
