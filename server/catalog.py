"""供给源目录 —— 通过 GET /api/catalog 下发给客户端。

集中管理「源」目录：哪些 provider 存在、所属层级、默认 base_url、展示信息。
改这里即可让所有客户端拿到新源，无需发版客户端。客户端拉取失败时会用其内置兜底。
（后续如需运营在线编辑，可迁移到 DB + admin CRUD，对客户端接口契约不变。）

字段说明：
  id              源标识（与客户端 config.json 里的 provider.id 对应）
  type            层级：free / p2p / paid
  enabled_default 客户端首次加载时的默认开关
  base_url        默认上游地址（已归一，网关会再去尾部 / 和 /v1）
  icon/label/hint 展示信息
  keyless         是否无需填 token（如 ollama、p2p）
  key_prefix      该源 API key 的常见前缀（智能粘贴时用于自动识别；可多个）。
                  歧义前缀（如 sk-）会由客户端拿 key 试探 base_url/models 来消歧。
  signup_url      领取 / 创建 API key 的页面深链（卡片「去领 key」按钮用）
  oauth           可选。该源支持的 OAuth 订阅登录添加方式：
                  {"provider": "claude"|"codex"|"google"|"copilot", "label": "按钮文案"}
                  客户端据此在预设卡片上额外提供「OAuth 登录」添加方式（除 API Key 外）。
"""

TIERS = ["free", "p2p", "paid"]

PROVIDER_CATALOG = [
    # ── 免费层 ──
    {"id": "ollama", "type": "free", "enabled_default": True, "base_url": "http://127.0.0.1:11434/v1",
     "icon": "🦙", "label": "Ollama", "hint": "自动检测本地实例，无需配置", "keyless": True,
     "key_prefix": [], "signup_url": "https://ollama.com/download"},
    {"id": "groq", "type": "free", "enabled_default": False, "base_url": "https://api.groq.com/openai/v1",
     "icon": "⚡", "label": "Groq", "hint": "免费申请：console.groq.com", "keyless": False,
     "key_prefix": ["gsk_"], "signup_url": "https://console.groq.com/keys"},
    {"id": "github-models", "type": "free", "enabled_default": False, "base_url": "https://models.inference.ai.azure.com",
     "icon": "🐙", "label": "GitHub Models", "hint": "免费调用 GPT-4o、Llama，需 GitHub PAT", "keyless": False,
     "key_prefix": ["ghp_", "github_pat_"], "signup_url": "https://github.com/settings/tokens"},
    # 整合自 gpt4free needs_auth（合法注册拿 key 的源，OpenAI 兼容）
    {"id": "cerebras", "type": "free", "enabled_default": False, "base_url": "https://api.cerebras.ai/v1",
     "icon": "🌀", "label": "Cerebras", "hint": "免费档每日 1M tokens：cloud.cerebras.ai", "keyless": False,
     "key_prefix": ["csk-"], "signup_url": "https://cloud.cerebras.ai"},
    {"id": "nvidia", "type": "free", "enabled_default": False, "base_url": "https://integrate.api.nvidia.com/v1",
     "icon": "🟢", "label": "NVIDIA NIM", "hint": "新用户免费额度：build.nvidia.com", "keyless": False,
     "key_prefix": ["nvapi-"], "signup_url": "https://build.nvidia.com"},
    {"id": "mistral", "type": "free", "enabled_default": False, "base_url": "https://api.mistral.ai/v1",
     "icon": "🌪", "label": "Mistral", "hint": "免费档：console.mistral.ai", "keyless": False,
     "key_prefix": [], "signup_url": "https://console.mistral.ai/api-keys/"},
    {"id": "openrouter", "type": "free", "enabled_default": False, "base_url": "https://openrouter.ai/api/v1",
     "icon": "🛣", "label": "OpenRouter", "hint": "含 :free 免费模型：openrouter.ai", "keyless": False,
     "key_prefix": ["sk-or-"], "signup_url": "https://openrouter.ai/keys"},
    {"id": "together", "type": "free", "enabled_default": False, "base_url": "https://api.together.xyz/v1",
     "icon": "🔗", "label": "Together AI", "hint": "新用户赠额：api.together.ai", "keyless": False,
     "key_prefix": ["tgp_v1_"], "signup_url": "https://api.together.ai/settings/api-keys"},
    {"id": "siliconflow", "type": "free", "enabled_default": False, "base_url": "https://api.siliconflow.cn/v1",
     "icon": "🧪", "label": "SiliconFlow", "hint": "国内免费源，新人 ¥16：siliconflow.cn", "keyless": False,
     "key_prefix": ["sk-"], "signup_url": "https://cloud.siliconflow.cn/account/ak"},
    {"id": "cohere", "type": "free", "enabled_default": False, "base_url": "https://api.cohere.ai/compatibility/v1",
     "icon": "🐬", "label": "Cohere", "hint": "Trial Key 免费：dashboard.cohere.com", "keyless": False,
     "key_prefix": [], "signup_url": "https://dashboard.cohere.com/api-keys"},
    # ── P2P 层 ──
    {"id": "tokenbank-p2p", "type": "p2p", "enabled_default": True, "base_url": "",
     "icon": "🌐", "label": "P2P 分享网络", "hint": "消耗积分使用社区共享算力", "keyless": True,
     "key_prefix": [], "signup_url": ""},
    # ── 付费层 ──
    {"id": "openai", "type": "paid", "enabled_default": False, "base_url": "https://api.openai.com/v1",
     "icon": "🤖", "label": "OpenAI", "hint": "付费 API，支持 GPT-4o / o3 等全系模型", "keyless": False,
     "key_prefix": ["sk-proj-", "sk-"], "signup_url": "https://platform.openai.com/api-keys",
     "oauth": {"provider": "codex", "label": "ChatGPT 订阅登录"}},
    {"id": "anthropic-paid", "type": "paid", "enabled_default": False, "base_url": "https://api.anthropic.com/v1",
     "icon": "🧬", "label": "Anthropic", "hint": "付费 API，Claude 3.5 / 3.7 等系列", "keyless": False,
     "key_prefix": ["sk-ant-"], "signup_url": "https://console.anthropic.com/settings/keys",
     "oauth": {"provider": "claude", "label": "Claude 订阅登录"}},
    {"id": "gemini", "type": "paid", "enabled_default": False,
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
     "icon": "💎", "label": "Google Gemini", "hint": "AI Studio 免费领 API Key", "keyless": False,
     "key_prefix": ["AIza"], "signup_url": "https://aistudio.google.com/app/apikey"},
    {"id": "github-copilot", "type": "paid", "enabled_default": False, "base_url": "https://api.githubcopilot.com",
     "icon": "🐱", "label": "GitHub Copilot", "hint": "用 GitHub 账号登录（需 Copilot 订阅）", "keyless": True,
     "key_prefix": [], "signup_url": "https://github.com/features/copilot",
     "oauth": {"provider": "copilot", "label": "GitHub 登录"}},
    {"id": "deepseek", "type": "paid", "enabled_default": False, "base_url": "https://api.deepseek.com/v1",
     "icon": "🐋", "label": "DeepSeek", "hint": "官方付费：platform.deepseek.com", "keyless": False,
     "key_prefix": ["sk-"], "signup_url": "https://platform.deepseek.com/api_keys"},
    {"id": "xai", "type": "paid", "enabled_default": False, "base_url": "https://api.x.ai/v1",
     "icon": "✖️", "label": "xAI Grok", "hint": "付费 API：console.x.ai", "keyless": False,
     "key_prefix": ["xai-"], "signup_url": "https://console.x.ai"},
    {"id": "fireworks", "type": "paid", "enabled_default": False, "base_url": "https://api.fireworks.ai/inference/v1",
     "icon": "🎆", "label": "Fireworks", "hint": "低价高速：fireworks.ai", "keyless": False,
     "key_prefix": ["fw_"], "signup_url": "https://fireworks.ai/account/api-keys"},
]
