# Cohere — Trial Key 免费 1000 次/月

Cohere 提供 OpenAI 兼容的 Compatibility API；Trial Key 免费档每月 1000 次调用 + 20 RPM。

## 步骤

1. 打开 https://dashboard.cohere.com/api-keys 用邮箱注册
2. 默认会创建一个 **Trial Key**，点显示并复制
3. 回到本应用粘贴并启用

## 限额（Trial 档）

- **1,000 调用/月**（所有模型共用）
- 20 RPM
- 超出后该 key 拒绝服务直到下月重置

## 推荐模型

- `command-r-plus-08-2024` — 旗舰，对 RAG / 工具调用优化
- `command-r-08-2024` — 平衡速度与质量
- `command-light` — 最快最便宜（仍计 1 次调用）

## 注意

- 端点是 `/compatibility/v1` 不是 `/v1`（Cohere 兼容端点路径）
- 模型偏向「企业搜索 / RAG」场景，普通对话也能用
- 中文支持不算强，重 RAG 场景再选
