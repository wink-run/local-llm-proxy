# Cloudflare Workers AI — 免费 10K 次/天

Cloudflare 的 Workers AI 平台提供 Llama 4 / Qwen 3 / DeepSeek Coder 等模型，**免费档每天 10,000 次调用**（按 neuron 计），OpenAI 兼容路径。

## 步骤

1. **注册 Cloudflare 账号**：https://dash.cloudflare.com
2. **拿到 Account ID**：登录后右下角侧栏 **Account ID**（一串 32 位 hex）→ 复制
3. **创建 API Token**：
   - https://dash.cloudflare.com/profile/api-tokens
   - **Create Token** → **Custom token**
   - Permissions: `Workers AI:Read`（仅这一项就够）
   - **Continue to summary** → **Create Token**
   - 复制 `xxxxxxx_…` token（关闭后看不到）
4. 回到本应用 → 添加 Cloudflare 时填两个字段：**Account ID** + **API Token**

## 限额（免费档）

- 每天 10,000 neurons（小模型一次调用 ~10 neurons，大模型可达 1000）
- 文档：https://developers.cloudflare.com/workers-ai/platform/limits/

## 推荐模型

- `@cf/meta/llama-4-8b-instruct` — Llama 4 8B
- `@cf/qwen/qwen3-7b-instruct` — Qwen 3 7B
- `@cf/deepseek-ai/deepseek-coder-6.7b-instruct` — 代码任务

## 注意

- Cloudflare 模型名都以 `@cf/` 开头，**严格区分大小写**
- 端点路径含 `{ACCOUNT_ID}`：`https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1`
- 中国大陆访问 Cloudflare API 通畅
