# P2P 共享池 —— Token Bank VPS

把一个 Token Bank 部署（你自己的 VPS 或社区 demo VPS）接入本地网关，享受社区贡献的模型；同时可启动 Agent 把自己 Ollama 暴露给社区。

## 默认 demo VPS

- URL：`http://81.70.249.144:8000`
- 注册：在浏览器打开 `http://81.70.249.144:8000/app` 用邮箱注册，即送新人积分
- 拿到 `sk-…` 用户 API key（个人页 → API Keys）

## 步骤（消费侧 — 用别人的模型）

1. 打开 `{VPS_URL}/app` 注册 / 登录
2. 个人页 → API Keys → 新建一个 `sk-…`
3. 回到本应用「供给源」→ P2P 共享池 → 立即启用
4. **VPS URL**：填 `http://81.70.249.144:8000`（或你自己的）
5. **API Key**：粘贴刚才的 `sk-…`
6. 测试连接 → 启用

## 步骤（贡献侧 — 把你的 Ollama 共享给别人）

1. 个人页 → 复制 `wk-…` Worker Key
2. 回到本应用「Agent」（隐藏页，地址栏访问 `/agent`）→ 填 worker_key → 启动
3. 你的本地 Ollama 模型会被注册到 VPS 共享池
4. 每 5 分钟结算一次贡献积分（按输出 token × 质量乘数）

## 积分体系（与旧 DESIGN.md 一致）

- **贡献**：每 1K output token × `contribute_rate` × `quality_multiplier`（0.5-1.5x）
- **消费**：每 (input+output) × `consume_rate`
- 全平台一种积分；可跨模型 / 跨层级兑换

## 注意

- VPS demo 是公开的，**敏感数据请用自有部署**
- Agent 启动后本机不能关机；可以挂在云主机上
- 共享池 model 列表是 VPS 端所有在线 worker 的模型并集，会动态变化
