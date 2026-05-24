# OpenRouter — 免费模型 API Key 获取

OpenRouter 是聚合 100+ 模型的中转平台，含一批 `:free` 后缀的免费模型。

## 步骤

1. 打开 https://openrouter.ai 并登录（Google / GitHub / 邮箱皆可）
2. 进入 https://openrouter.ai/settings/keys
3. 点击 **Create Key** → 命名 → **限额可以设 $0**（仅用免费模型）
4. **立刻复制** 显示的 `sk-or-…` 开头的 key
5. 回到本应用粘贴并测试连接

## 限额（免费档）

- 含 `:free` 后缀的模型：RPD 50（每天 50 次）
- 普通模型按充值余额计费，**不充值就只能用免费模型**

## 推荐模型（必须带 `:free` 后缀）

- `meta-llama/llama-4-70b-instruct:free` — Llama 4 主力
- `deepseek/deepseek-r1:free` — 推理模型
- `deepseek/deepseek-v3:free` — 通用对话
- `qwen/qwen3-72b-instruct:free` — Qwen 3
- `google/gemini-2.5-flash-exp:free` — Gemini 2.5 Flash 实验通道

## 注意

- **必须带 `:free` 后缀**，否则会扣余额（即使余额 0 也会被拒）
- 在本应用配置时，模型名留意复制完整
- 免费模型可能随时下线，被拒就换一个
