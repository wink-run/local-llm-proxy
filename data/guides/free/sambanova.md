# SambaNova Cloud — Llama 4 405B 公开免费

SambaNova 自家 RDU 芯片做推理，速度比 Groq 还快，**Llama 4 405B 全模型对公开 user 免费**（限速宽松）。

## 步骤

1. 打开 https://cloud.sambanova.ai 用邮箱注册
2. 验证邮箱 → 登录后左侧 **API** 标签
3. 点 **Generate New API Key** → 复制 `sk-sn_…` 开头的 key
4. 回到本应用粘贴并启用

## 限额（免费档）

- Llama 4 405B：~5 RPM（其它模型限速更宽松）
- 单次响应较大模型可能 1-2 秒 TTFT，但生成极快（~500 tok/s）

## 推荐模型

- `Meta-Llama-4-405B-Instruct` — 旗舰；其它平台付费才有
- `Meta-Llama-4-70B-Instruct` — 主力
- `DeepSeek-R1` — 推理模型
- `Qwen3-32B` — 中文场景

## 注意

- OpenAI 兼容端点
- 实测国内连接可用，但 latency 较高
- 不要把 key 提交到公开仓库
