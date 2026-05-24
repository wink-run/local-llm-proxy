# NVIDIA NIM — 免费调用 Llama 4 / DeepSeek R1 / Nemotron

NVIDIA 自家的 Build 平台提供 NIM (NVIDIA Inference Microservices) 端点，注册即送一批免费调用次数，覆盖 Meta Llama 4 / DeepSeek R1+V3 / Mistral / Qwen / Nemotron 等顶级模型。

## 步骤

1. 打开 https://build.nvidia.com 用 NVIDIA / Google / GitHub 账号注册
2. 任意进入一个模型卡（如 [Llama 4 405B](https://build.nvidia.com/meta/llama-4-405b-instruct)）
3. 右上角点 **Get API Key** → 同意条款 → 复制 `nvapi-…` 开头的 key
4. 回到本应用粘贴并启用

## 限额（免费档）

- 新用户默认 **1,000 次免费调用**（所有模型共用配额）
- 超后可订阅 NVIDIA AI Enterprise（企业级）或申请研究项目延期
- 实测速度：US 节点 ~150-300ms TTFT，旗舰模型稳定

## 推荐模型

- `meta/llama-4-405b-instruct` — Llama 4 旗舰
- `meta/llama-4-70b-instruct` — 主力性价比
- `deepseek-ai/deepseek-r1` — 推理王
- `deepseek-ai/deepseek-v3` — 通用强模型
- `qwen/qwen3-coder-32b-instruct` — 代码任务
- `nvidia/nemotron-4-340b-instruct` — NVIDIA 自家旗舰

## 注意

- 端点 OpenAI 兼容，**直接走 /v1/chat/completions**
- 1000 次用完后该 key 拒绝服务；可以**多账号轮换**
- 国内访问可能需要代理
