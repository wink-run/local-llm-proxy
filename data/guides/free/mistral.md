# Mistral AI — 免费 1 RPS / 500K tokens / 月

Mistral 官方 API 提供免费层：1 请求/秒 + 500K tokens/月。Codestral 模型走单独配额，限速宽松（30 RPS）。

## 步骤

1. 打开 https://console.mistral.ai/api-keys 用邮箱注册
2. 在控制台 **API Keys** → **Create new key**
3. 选 **Free tier** (默认) → 复制 `xxxxx_…` 开头的 key
4. 回到本应用粘贴并启用

## 限额（免费档）

- **通用模型**：1 RPS / 500K tokens/月
- **Codestral** 单独配额：30 RPS / 250K tokens/天 — 代码任务首选

## 推荐模型

- `codestral-latest` — 代码任务，限速宽松
- `mistral-large-latest` — 旗舰对话
- `mistral-small-latest` — 快速兜底
- `open-mixtral-8x22b` — Mixtral MoE

## 注意

- 端点 OpenAI 兼容，**通用 /v1/chat/completions**
- 国内访问可能需要代理
- key 不区分模型，但 codestral 用单独限速桶
