# Google AI Studio (Gemini) — 免费 API Key 获取

Google 官方的 Gemini 免费 API，限额高、模型质量强。

## 步骤

1. 打开 https://aistudio.google.com/apikey （需要 Google 账号）
2. 点击 **Create API key** → 选择一个 Google Cloud 项目（默认即可）
3. **立刻复制** 显示的 key（`AIza…` 开头）
4. 回到本应用粘贴并测试连接

## 限额（免费档，按模型不同）

| 模型 | RPM | TPM | RPD |
|---|---|---|---|
| gemini-2.5-flash | 15 | 1M | 1,500 |
| gemini-2.5-flash-lite | 30 | 1M | 1,500 |
| gemini-2.5-pro | 2 | 32k | 50 |

## 推荐模型

- `gemini-2.5-pro` — 旗舰，含 **2M token 上下文**，复杂任务首选（限额较紧）
- `gemini-2.5-flash` — 日常主力，平衡速度与质量
- `gemini-2.5-flash-lite` — 最便宜最快，适合简单分类 / 提取

## 注意

- 用的是 OpenAI 兼容端点（`/v1beta/openai`），不是原生 Gemini 端点
- 国内访问可能需要代理
- 通过免费档使用的请求会被 Google 用于训练，**敏感数据不要走免费档**
