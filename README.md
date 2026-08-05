# Token Bank

> **Personal AI Hub · Token Manager**
>
> See clearly · Spend less · Stay simple · Get smarter with you · Earn from idle
>
> One-click Claude / Cursor / Codex onboarding · one-stop trace & routing · portrait-driven discovery · community sharing

[中文文档](./README.zh-CN.md) · [Download Latest](https://github.com/wink-run/tokenbank/releases/latest) · [Architecture](./DESIGN.md) · [Privacy Policy](./docs/PRIVACY_POLICY.md)

---

## Why Token Bank

Pain points it tackles:

- Many model plans, little clarity on where tokens go each day
- Free quotas sit unused while paid bills rise; local models idle
- Tools, accounts, and devices don’t line up; Skills / MCP / prompts pile up
- Month-end plan credits expire unused

**Token Bank is your personal AI hub.** Plug Claude Code, Codex, Cursor, Gemini CLI and more into a local gateway—keep familiar clients, **see clearly, spend less, stay simple**, grow resources from your habits (**get smarter with you**), and turn idle capacity into credits via **community sharing** (**earn from idle**).

**Five pillars:**

| Pillar | What you get |
|---|---|
| **See clearly** | One-click onboard; full trace; multi-device analytics; subscriptions vs PAYG side by side |
| **Spend less** | Seamless model swap; smart local-first routing; scene strategies; optional lossless compression |
| **Stay simple** | One-click onboard/restore; multi-account CLI by directory; tray status; one local address |
| **Get smarter with you** | Work portrait; personalized MCP / Skill / Prompt / Agent discover · accumulate · iterate |
| **Earn from idle** | Contribute idle capacity for credits; circles & network map |

---

## Core capabilities: one-click onboarding · seamless model swap · full trace

Token Bank is more than an API proxy — it brings **Claude Code, Codex, Gemini CLI, Cursor, Copilot**, and other mainstream agents under one local gateway. **No agent-side changes required** for usage tracing, third-party model switching, and smart routing.

### One-click agent onboarding

Open the **Gateway** tab — installed tools appear automatically (desktop apps can be added manually):

| Agent | How it connects |
|---|---|
| Claude Code / Codex CLI / Gemini CLI / OpenCode / … | CLI shim: injects `BASE_URL` env vars transparently — no command changes |
| Claude Desktop / Codex Desktop / OpenClaw | Config-file patch: one click to point at the local gateway |
| Cursor and other OpenAI-compatible clients | Set `OPENAI_BASE_URL`, or create a dedicated key in Gateway |

**Onboarding flow:**

1. Click **Track** → start counting that app's token usage (even on the official subscription)
2. Pick a **model or scene route** in the dropdown → config is rewritten automatically; traffic goes through the gateway
3. Click **Revert** → restore the official config and stop tracking

Three states, clearly separated: **stats only** (official sub + session import), **via gateway** (route bound + live proxy), **reverted** (original config restored).

### Seamless third-party model switching

Agents keep their native model names (`claude-sonnet-4-6`, `gpt-5`, …). **The client never needs to change:**

```
Claude Code requests claude-sonnet-4-6
        ↓  gateway keyScene transparent rewrite
Actually routed → Groq llama-3.3-70b / local Ollama / DeepSeek / …
        ↓  protocol adapter
Anthropic Messages ↔ OpenAI Chat ↔ Codex Responses
```

- **Model names unchanged** — Claude client validation and UI stay the same
- **Automatic protocol conversion** — `/v1/messages`, `/v1/chat/completions`, `/v1/responses` each handled
- **Per-app bindings** — Claude Code on free Groq, Codex on local Ollama, independently
- **Switch back anytime** — choose "Direct (official)" in the route dropdown; config is restored cleanly

### Session trace (live proxy + session import)

Usage is traced whether or not traffic goes through the gateway:

| Mode | What it does |
|---|---|
| **Live proxy** | Requests via `localhost:11430` — logs route chain, resolved model, tokens, latency, cost |
| **Session import** | Tracked apps that still hit the official API — local session logs (`~/.claude`, `~/.codex`, …) are scanned and imported |
| **Dedup** | Same call recorded by both gateway and session file → counted once |

Trace data appears on the **Dashboard** sliced by **app · provider · model · supply type · device · time**; the call log shows route result and latency per request.

### Smart routing

Supply is organized into **local sources** and **community sharing sources**. Each app can bind its own route; a global supply chain acts as fallback:

```
Per-app binding (keyScene / scene routes)
    ↓ unbound or llm-router-* model
Smart supply chain
    Local: Ollama → free API (Groq / GitHub Models) → subscription / PAYG API
    ↓ local unavailable or need extra compute
    Community sharing (spend credits on shared community compute)
    ↓ policy groups
fallback · round-robin · weighted · latency · direct
```

| Supply type | Includes | Notes |
|---|---|---|
| **Local sources** | Ollama, free API, APP/API subscriptions, pay-as-you-go | Forwarded by your local gateway; keys never leave the machine |
| **Community sharing** | Shared community compute network | Spend credits on remote nodes; model list synced dynamically |

- **Scene routes** — daily chat, code completion, long-doc analysis each get their own chain
- **Policy groups** — pick provider order from task features (tool calls, context length, …)
- **Failover** — local source down? try community sharing automatically; fully transparent to the agent

### Gateway lossless compression

Optional **lossless JSON compression** before forwarding — fewer input tokens upstream, **semantics unchanged**:

- Minifies pretty-printed JSON in messages (tool results, embedded data); strips whitespace only
- Non-JSON content is left byte-for-byte untouched — answers stay the same
- Enable in **Config**, or set `TOKENBANK_COMPRESS=1`
- **Dashboard** shows compression count, tokens saved, and ratio; cloud merge across devices when signed in

### Multi-device usage aggregation

Desktop, CLI, and server gateways each register as a device — **usage is reported and merged in the cloud** when signed in:

| Capability | What it does |
|---|---|
| **Device registration** | Each machine gets a persistent device_id; 60s heartbeat tracks online status |
| **Inventory snapshots** | Reports calls, tokens, cost, local / community sharing mix, top models/apps for 1 / 7 / 30 day windows |
| **Cloud merge** | **Profile** and **Dashboard** show per-device share, online status, detail vs aggregate views |
| **Cross-device sync** | Subscriptions, PAYG config, and tool lists sync on login — no re-setup when switching machines |

### Unified subscription management

The **Profile** tab is the single hub for all billing accounts; **Providers** handles keys and routing:

| Type | How it's managed | Typical use |
|---|---|---|
| **APP subscription** | Register ChatGPT / Claude / Gemini / Cursor plans and monthly cost | Stats-only on official sub, or OAuth → API gateway |
| **API subscription** | Separate catalog for vendor API plans (e.g. Volcengine Coding Plan) | API Key gateway, billed separately from APP subs |
| **Pay-as-you-go** | Register providers, model lists, and USD/M-token list prices | Providers page only exposes models configured here; cost estimates use these rates |

- **Cloud sync** — subscriptions and PAYG config download on login; Mac / Windows / Linux stay in sync
- **Billing overlay** — daily subscription amortization + PAYG estimates alongside raw token stats
- **Supply linkage** — Profile defines *what you use and what it costs*; Providers defines *how to connect and route*

### Dynamic supply delivery

Local source catalogs and tool lists don't require manual version bumps — **sync on login, refresh when online**:

```
Server-maintained
    ├── Local source catalog (Ollama / Groq / GitHub Models / SiliconFlow …)
    ├── Tool list config.apps (agent onboarding rules, protocol adapters)
    └── Scene routes config.scenes (preset routing chains)
         ↓  auto-fetched on login / startup
Local gateway
    ├── Merged into ~/.tokenbank/tokenbank.yaml
    ├── Community sharing online models refreshed periodically (/v1/models → route candidates)
    └── One-click env scan — import existing free keys with round-robin
```

- **Local catalog delivery** — Groq, Cerebras, GitHub Models, NVIDIA NIM, etc. listed under **Local sources**; admins hot-update via YAML upload
- **Community sharing models** — online contributor models pulled live; no manual local registration
- **Env scan** — one-click import of existing Groq / GitHub Models / Anthropic keys; multi-key round-robin
- **Offline fallback** — built-in defaults when offline; server deltas merged automatically when back online

### Multi-account CLI & directory dispatch

Run multiple logins of the same CLI (Claude Code / Codex). The gateway picks the right instance by **working directory** so configs never collide:

| Capability | What it does |
|---|---|
| **Auto-scan** | Discover existing CLI account instances on startup or manual rescan |
| **Manual add** | Gateway → “CLI instance” for accounts the scanner misses |
| **Effective directory** | Bind each instance to a workdir; the shim injects env from `$PWD` |
| **Quota visibility** | Claude / Codex subscription meters; tray and app list show today’s usage |

### Agent orchestration (Playground)

**Debug / Playground** is more than a single-model chat:

- Set a **main agent** as the aggregation entry for natural-language tasks
- The main agent can plan steps and dispatch to other onboarded agents (including Kimi / Cursor runtimes)
- Chunked conversation stream, visible tool calls, stop then continue
- Agent visibility is gated by **runtime projection** — only projected agents appear in Debug

### Resource hub: MCP · Skill · Prompt

The **Resources** tab consolidates community picks and personal assets:

| Type | Capability |
|---|---|
| **Community catalog** | Sync recommended MCP / Skill / Prompt / Agent lists on login (cache-first, built-in offline fallback) |
| **Projection** | Project resources onto specific agents; revoke anytime; cascade deps on onboard |
| **Prompt MCP** | Prompts no longer materialize as slash-command files — served via `tokenbank-prompts` (`tb_get_prompt` / `tb_list_prompts`) filtered by projection set |
| **Work-portrait posters** | Dashboard can export four poster styles (pro / cute / humor / minimal) for sharing your usage portrait |

---

## Five things it does

### 1 — See clearly

Token Bank logs every request: which route it took, which model answered, how many tokens, how long it took.

- **One-click onboard & inventory**: stats-only / via gateway / restore; per-app calls, tokens, cost
- **Full trace**: live proxy + session import with auto-dedupe
- **Multi-device analytics**: app · provider · model · cost · device · time; cloud merge when signed in
- **Subscriptions vs PAYG**: APP / API / metered side by side with daily accrual and list-price estimates

### 2 — Spend less

A **smart local-first routing chain**, with community sharing as fallback:

```
Local: Ollama → free APIs → subscription / PAYG
    ↓ unavailable or need extra capacity
Community sharing (spend credits on shared compute)
```

- **Seamless model swap**: native model names unchanged; protocols adapted automatically
- **Scene strategies**: different chains for chat / completion / long docs; failover transparent to agents
- **Lossless compression**: fewer upstream input tokens, meaning unchanged

### 3 — Stay simple

- **One-click onboard/restore** on the Gateway page
- **Multi-account CLI** by working directory; menu-bar tray for status and today’s usage
- **OpenAI-compatible endpoint**: point existing tools at one local address
- **Playground orchestration**: main agent takes tasks and hands off; tool streams visible

### 4 — Get smarter with you

- **Work portrait** mined from real calls and habits; reusable across skills, prompts, agents
- **For You**: personalized MCP / Skill / Prompt / Agent discovery
- **Accumulate & iterate**: keep assets in your library; reuse portrait to rediscover, or remine; compose when the catalog falls short

### 5 — Earn from idle

Contribute unused compute or API quota to **community sharing**, earn credits, spend them on shared models.

**You can contribute:** local Ollama, unused upstream quota, private LAN models (outbound WebSocket—no inbound port)

```
credits = (output_tokens / 1000) × contribute_rate × quality_multiplier (0.5–1.5)
spend   = ((prompt + completion tokens) / 1000) × consume_rate
```

Contribute rate > consume rate; plus check-in, wheel, and referrals. Circles share models and credits.

---

## Quick start

### Desktop app (Mac / Windows — recommended)

Download the installer from [Releases](https://github.com/wink-run/tokenbank/releases/latest):

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
git clone https://github.com/wink-run/tokenbank.git
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
git clone https://github.com/wink-run/tokenbank.git
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

### Gateway · one-click onboarding & toolbox

App list with today's usage, plus the App toolbox to install / remove Claude Code, Kimi Code, Cursor, Codex, and more.

![Gateway · apps & toolbox](server/static/screenshots/gateway-apps.webp)

### Sessions · unified cross-app trace

Filter by Claude Desktop / Cursor / Kimi Code / Codex, inspect tokens and cost, hand off or export.

![Gateway · sessions](server/static/screenshots/gateway-sessions.webp)

### Session Trace · step-level observability

Per-session steps, tool calls, skills used, and token breakdown (sealed reasoning when required by the API).

![Session Trace](server/static/screenshots/session-trace.webp)

### Providers · personal compute + community sharing

Speed-test personal models with status lights; spend credits on community-shared models.

![Providers](server/static/screenshots/providers.webp)

### Assets · Agents / Skills / Prompts

Manage agents and project them onto runtime CLIs; community “For You” picks and work portrait.

![Assets · agents](server/static/screenshots/assets-agents.webp)

![Assets · For You & portrait](server/static/screenshots/assets-for-you.webp)

### Playground · agent orchestration

Main agent receives tasks with tool streams and terminal collaboration; runtimes include Claude Code / Codex / Cursor / Kimi Code.

![Playground · Agent mode](server/static/screenshots/playground.webp)

### Usage · spend visibility

Requests / tokens / free-hit rate / estimated cost; per-app mix and daily trend.

![Usage](server/static/screenshots/usage.webp)

### Circles · share compute with friends

Create or join circles; invite friends to share models and credits.

![Circles](server/static/screenshots/circles.webp)

### Contribute · earn from idle quota

Contribute local models to the community network for credits; keys never leave the machine.

![Contribute](server/static/screenshots/contribute.webp)

### Global network · node map

Online nodes, available models, and geographic distribution.

![Global community network](server/static/screenshots/network.webp)

### Tray · always-on glance

Gateway status, per-app TTFT / today’s usage; open the main panel in one click.

![Tray panel](server/static/screenshots/tray.webp)

| Page | What you can do |
|---|---|
| **Usage** | Multi-dimensional stats: app share, **local / community sharing** mix, cost estimates; **work-portrait posters** |
| **Gateway** | **One-click onboarding** + **multi-account CLI**; session Trace; scene routes & supply chain |
| **Playground** | **Agent orchestration**: main agent receives tasks and dispatches; tool streams, stop/resume |
| **Assets** | Community **MCP / Skill / Prompt / Agent** catalog; projection gating; portrait recommendations |
| **Providers** | **Local sources** and **community sharing**; speed tests & dynamic catalog |
| **Circles / Contribute / Network** | Circles · contributor nodes · global node map |
| **Config** | Gateway port, timeout, concurrency · lossless compression · cloud account URL |

---

## Connecting any OpenAI-compatible client

```bash
# Claude Code (or one-click onboard in Gateway — auto-injects ANTHROPIC_BASE_URL)
export ANTHROPIC_BASE_URL=http://localhost:11430

# Codex CLI (Gateway onboarding auto-injects OPENAI_BASE_URL)
export OPENAI_BASE_URL=http://localhost:11430/v1

# Cursor / any OpenAI-compatible tool
OPENAI_BASE_URL=http://localhost:11430/v1
OPENAI_API_KEY=your-local-key

# Quick curl test
curl http://localhost:11430/v1/chat/completions \
  -H "Authorization: Bearer your-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

> Prefer **Gateway → Track** for one-click onboarding — no manual env vars. Pick a route and the agent keeps its native model names while the gateway transparently forwards to your chosen provider.

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
**Token Bank · https://github.com/wink-run/tokenbank**

---

## Disclaimer

This project is for educational and research purposes only. Users are responsible for complying with applicable laws, regulations, and upstream service terms. The authors assume no liability for any consequences arising from deployment, compute sharing, or request forwarding.
