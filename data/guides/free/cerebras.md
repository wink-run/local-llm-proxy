# Cerebras Cloud — 免费 API Key 获取

Cerebras 用专属 wafer-scale 芯片做推理，速度比 Groq 还快，适合做 latency 敏感的实验。

## 步骤

1. 打开 https://cloud.cerebras.ai/platform/
2. 用 Google 账号或邮箱注册并登录
3. 左侧菜单进入 **API Keys** → **Create API Key**
4. 命名后创建，**立刻复制** 显示的 `csk-…` 开头的 key
5. 回到本应用粘贴并测试连接

## 限额（免费档）

- 每日 1M tokens 总额
- RPM 30
- 仅支持 chat completion，不支持 image / embedding

## 推荐模型

- `llama-4-70b` — 主力 70B 模型（Llama 4 系列）
- `llama-4-8b` — 轻量 8B，CS-3 上极快
- `qwen-3-32b` — Qwen 3 32B
- `llama-3.3-70b` — 仍可用的上一代

## 注意

- 接口 OpenAI 兼容
- 由于专用硬件，仅特定 Llama 系列可用，不支持其它厂商模型
