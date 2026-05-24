# Groq Cloud — 免费 API Key 获取

Groq 提供基于 LPU 的高速推理服务，免费档限速宽松，适合做模型试用与轻量任务。

## 步骤

1. 打开 https://console.groq.com/keys （需要 Google / GitHub 账号登录）
2. 点击右上角 **Create API Key**
3. 起个名字（例如 `local-llm-proxy`）→ 点击 **Submit**
4. **立刻复制** 显示的 key（`gsk_…` 开头），关闭弹窗后无法再看到
5. 回到本应用，粘贴到下面的输入框，点 **测试连接**

## 限额（免费档，2026-05 数据）

| 资源 | 限制 |
|---|---|
| RPM (请求/分钟) | 30 |
| RPD (请求/天) | 14,400 |
| TPM (tokens/分钟) | 6,000 |
| TPD (tokens/天) | 500,000 |

## 推荐模型

- `llama-4-70b-instruct` — Llama 4 70B 主力模型，质量与速度兼顾
- `llama-4-8b-instant` — Llama 4 8B，超低延迟，适合代码补全
- `qwen-3-32b` — Qwen 3 32B，中文场景表现强
- `kimi-k2` — Moonshot K2 长上下文
- `llama-3.3-70b-versatile` — 仍可用的上一代主力

## 注意

- key 串绑账号，被滥用会被禁用 —— **不要在公开仓库提交**
- 接口完全 OpenAI 兼容，无需修改客户端
