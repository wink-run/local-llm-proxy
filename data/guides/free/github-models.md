# GitHub Models — 免费调用 GPT-4o / Llama / Phi 等

GitHub 在 2024 末推出的免费 LLM 网关，OpenAI 兼容协议，通过 GitHub Personal Access Token (PAT) 鉴权。**不用绑信用卡**。

## 步骤

1. **登录 GitHub 账号**（已登录就跳过）
2. **创建 Personal Access Token**
   - 打开 https://github.com/settings/tokens?type=beta
   - 推荐 **Fine-grained token**（注意：**无需额外权限**，全部 Permission 留默认即可）
   - Name：`local-llm-proxy`
   - Expiration：自选（最长 1 年）
   - Resource owner：你自己
   - Repository access：随便（不会用到 repo）
   - 滑到底点 **Generate token** → **立刻复制** `github_pat_xxx`
3. **回到本应用粘贴** → 点 **测试并启用**

## 限额（免费档）

| 资源 | 限制 |
|---|---|
| RPM (请求/分钟) | 因模型而异，10–20 |
| TPM (tokens/分钟) | 8k–32k |
| RPD (请求/天) | 50–150 |
| 高级模型 (gpt-4o) | 配额更紧 |

## 推荐模型

- `gpt-5.5` — 主力，质量最好（限额较紧）
- `gpt-5.5-mini` — 快速兜底，限额宽松
- `gpt-5.5-instant` — 极速对话
- `Meta-Llama-4-405B-Instruct` — Meta 旗舰，长上下文
- `Phi-4` — 微软小型推理模型
- `DeepSeek-R1` — 通过 Azure 提供的 R1

## 注意

- 端点是 Azure Inference SDK URL：`https://models.inference.ai.azure.com`
- Token 串绑账号，**不要在公开仓库提交**
- 如果限速明显，换 `gpt-5.5-mini` 或 `Phi-4`
