# Token Bank

> **Local LLM Gateway · Token Manager**
>
> Know what you're spending · Spend less · Earn from what's idle

[中文文档](./README.zh-CN.md) · [Download Latest](https://github.com/wink-run/local-llm-proxy/releases/latest) · [Architecture](./DESIGN.md)

---

## Why Token Bank

You've probably run into these problems:

- Subscribed to multiple LLM providers with no clear view of where tokens actually go
- Groq free tier and GitHub Models quota go unused every month, yet the OpenAI bill keeps climbing
- Ollama is running locally, but AI tools still call the paid API by default
- Month-end API plan credits expire and reset to zero — wasted

**Token Bank is a local LLM gateway** that sits between your AI tools and every LLM provider. It helps you understand your token usage, cut costs automatically, and turn idle quota into credits.

**Three pillars in v0.4:**

| Pillar | What you get |
|---|---|
| **Agent trace & onboarding** | Register Cursor, Claude Code, Codex CLI, Cherry Studio, and other agents in one gateway — proxy traffic in real time or import session logs so usage is traced even when apps bypass the gateway |
| **Personal subscription hub** | Manage APP subscriptions (stats-only or API gateway), API subscriptions (e.g. Volcengine), and pay-as-you-go providers with per-model list prices — gateway picks models from your profile |
| **Multi-dimensional analytics** | Dashboard slices usage by **app · provider · model · tier · cost · device · time range**, with subscription amortization and PAYG estimates in one view |

---

## Three things it does

### 1 — Know what you're spending

Token Bank logs every request: which route it took, which model answered, how many tokens it used, and how long it took.

- **Agent-aware inventory**: onboard common agents in the Gateway tab; see per-app calls, tokens, cost, and proxy vs session-import mix
- **Daily dashboard**: total calls, free tier hit rate, provider breakdown, model distribution (by calls / tokens / cost)
- **Call log**: route result, status, and latency for every request
- **Multi-device view**: today's usage per device (desktop + CLI + server), aggregated in the cloud when signed in
- **Billing overlay**: subscription plans amortized by day + pay-as-you-go list-price estimates alongside raw token stats
- **Credit history**: every earn and spend is recorded; balance is always up to date

---

### Personal subscription & PAYG (Profile)

Keep subscriptions and metered providers in one place — separate from the raw provider key store:

| Type | Purpose |
|---|---|
| **APP subscription** | ChatGPT, Claude, Gemini, etc. — stats-only, or convert to API gateway via OAuth |
| **API subscription** | Vendor API plans (e.g. Volcengine Coding Plan) — API Key gateway, independent catalog |
| **Pay-as-you-go** | OpenAI, Anthropic, custom providers — register models and USD/M-token list prices; gateway only allows models you configured here |

The **Providers** page wires keys and routes; the **Profile → Subscriptions / PAYG** tabs define what counts toward billing analytics and which models each PAYG source may expose.

---

### 2 — Spend less

Token Bank runs a **smart routing chain** locally. Each request works down the chain until one source succeeds:

```
Local models (Ollama)
    ↓ no matching model
Free tier (Groq / GitHub Models / ...)
    ↓ rate-limited or unavailable
P2P network (pay with credits)
    ↓ insufficient credits
Paid API (OpenAI / Anthropic / ...)
```

**Your AI tools point at one local address.** Routing is completely transparent to them.

#### Scene routes

Different use cases can be mapped to different supply chains:

| Scene | Strategy |
|---|---|
| Daily chat | Groq free tier first, P2P network as fallback |
| Code completion | Local Ollama — zero latency, zero cost |
| Long document analysis | Paid API — quality guaranteed |

#### Auto-import existing keys

One-click scan of your environment variables and tool configs. Existing LLM keys (Groq, GitHub Models, Anthropic, etc.) are imported automatically. Multiple keys are round-robined to fully use each provider's free quota.

---

### 3 — Earn from what's idle

Contribute your unused compute or API quota to the P2P network. Earn credits. Spend those credits on models you don't have access to.

**What you can contribute:**

- Local Ollama / inference server (contribute compute)
- Unused upstream API paths (contribute quota)
- Private models behind a corporate LAN (the agent dials out over WebSocket — no inbound port required)

**How credits are earned (settled every ~5 minutes):**

```
credits = (output_tokens / 1000) × model_contribute_rate × quality_multiplier
```

The quality multiplier (0.5–1.5×) is calculated from uptime, response latency, and success rate. Nodes that are consistently online and fast earn more.

**Other credit sources:**
- Daily check-in
- Daily spin wheel
- Referrals

**How credits are spent:**

```
cost = ((prompt + completion tokens) / 1000) × model_consume_rate
```

By design, contribute rate > consume rate — long-term contributors come out ahead.

---

## Quick start

### Desktop app (Mac / Windows — recommended)

Download the installer from [Releases](https://github.com/wink-run/local-llm-proxy/releases/latest):

- **macOS** `.dmg` — double-click to install, lives in the menu bar, auto-updates
- **Windows** `.exe` — NSIS installer, auto-updates

After installing: open the app → go to **Config** → enter your backend URL and P2P key → done.

**Point your AI tools at the local gateway:**

```
OPENAI_BASE_URL=http://localhost:11430/v1
```

Create a local API key in the **Gateway** tab, or use an existing upstream key.

---

### CLI mode (Linux / servers)

```bash
git clone https://github.com/wink-run/local-llm-proxy.git
cd local-llm-proxy/client
npm install
node cli/gateway.js start
```

Open `http://localhost:11431` in a browser to configure. Works identically to the desktop app.

```bash
# Background (nohup)
nohup node cli/gateway.js start > gateway.log 2>&1 &

# Or with pm2
pm2 start cli/gateway.js -- start
```

---

### Docker (containerised)

```bash
git clone https://github.com/wink-run/local-llm-proxy.git
cd local-llm-proxy

docker compose up gateway -d
```

The `gateway-data/` volume is mounted automatically; **`local-config.json` is created on first start**. Configure routes and apps in the Web UI on `:11431`. See [`gateway-data/README.md`](./gateway-data/README.md).

| Port | Purpose |
|---|---|
| `11430` | LLM requests (`OPENAI_BASE_URL=http://host:11430/v1`) |
| `11431` | Web management UI |

---

## What's in the UI

| Page | What you can do |
|---|---|
| **Dashboard** | Multi-dimensional stats: app/agent share, provider tier mix, model rankings (calls · tokens · cost), hourly trend, estimated PAYG + subscription cost |
| **Gateway** | Onboard agents (Cursor, Claude Code, Codex, …), supply chain config, scene routes, gateway status and logs |
| **Providers** | Free / P2P / paid tiers; APP-sub OAuth vs API-sub Key vs PAYG Key; model allowlists synced from Profile PAYG |
| **Profile** | P2P credits · **Subscriptions** (APP + API) · **Pay-as-you-go** (providers, models, list prices) · per-device inventory |
| **Network** | Global node map, online contributors, available models |
| **Contribute** | Node status, settlement history, quality multiplier trend |

---

## Connecting any OpenAI-compatible client

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://localhost:11430

# Cursor / any OpenAI-compatible tool
OPENAI_BASE_URL=http://localhost:11430/v1
OPENAI_API_KEY=your-local-key

# Quick curl test
curl http://localhost:11430/v1/chat/completions \
  -H "Authorization: Bearer your-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

---

## Self-hosted P2P backend (optional)

To run your own private network instead of using the public one:

```bash
cp .env.example .env
# Edit .env — set ADMIN_KEY
docker compose up proxy -d
```

| Variable | Description |
|---|---|
| `ADMIN_KEY` | Admin dashboard password |
| `REQUEST_TIMEOUT` | Per-request forwarding timeout in seconds (default `120`) |

- Admin dashboard: `http://YOUR_VPS:8000/admin/ui`
- User portal: `http://YOUR_VPS:8000/app`
- Worker WebSocket: `ws://YOUR_VPS:8000/ws/worker`

### Contributing a worker node

```bash
cd agent && pip install -r requirements.txt

python agent.py register \
  --server     "ws://YOUR_VPS:8000/ws/worker" \
  --worker-key "wk-... from the user portal" \
  --models     "llama3,qwen2" \
  --llm-url    "http://localhost:11434" \
  --name       "my-machine"

python agent.py start
```

**Upstream API keys never leave your machine.** Only the worker key and model list are sent during registration.

---

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).  
Redistribution and derivative works must retain the NOTICE and credit the source:  
**Token Bank · https://github.com/wink-run/local-llm-proxy**

---

## Disclaimer

This project is for educational and research purposes only. Users are responsible for complying with applicable laws, regulations, and upstream service terms. The authors assume no liability for any consequences arising from deployment, compute sharing, or request forwarding.
