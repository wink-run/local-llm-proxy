# 贡献武将（Agent）· 本地 WebSocket 接单 —— 设计文档

日期:2026-07-26  
状态:**已定方向（待实现方案）**  
相关:[武将库产品设计](./2026-07-25-tokenbank-generals-product-design.md) · [价值闭环](./2026-07-25-ai-asset-value-loop-design.md) · [反笔记陷阱](./2026-07-25-anti-notes-trap-design.md) · [MCP 点将](./2026-07-25-general-roster-mcp-design.md)

---

## 1. 背景与目标

### 1.1 现状

- **模型贡献（已落地）**：贡献页勾选本机模型 → worker 经 `ws/worker` 上报 → 社区请求路由到本机执行 → 积分结息。
- **武将自用（推进中）**：投射 + MCP 点将 / 本机 `dispatchAndWait` → 驱动 Codex / Claude Code / Cursor 等投射应用。
- **武将出租（叙事有、实现缺）**：产品主文档写过「闲将出租换积分」，但贡献页仍只有模型，缺少与模型同构的接单通道。

### 1.2 问题

若用「把武将正文上架给对方本地点将」做出租，**soul / Prompt / Skill 会泄漏**，二次传播无法用积分挽回。

### 1.3 目标一句话

> **贡献武将 = 模型贡献同款本地 WebSocket 接单：任务在贡献者机器上由 executor 驱动已投射应用执行；调用方只拿结果，拿不到兵书全文。**

成功标准（一期）：

1. 贡献者可显式勾选武将对外接单（公开 / 圈子）。
2. 勾选时校验：已投射且 runtime 可用；否则不可开。
3. 调用方能在社区或圈子发现并发起远程任务；结果回传；贡献者获积分。
4. 协议与 UI **不上报、不下发** soul / prompts / skills 正文。

---

## 2. 已定决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 通道 | **扩展现有** `ws/worker`，不新开 agent-worker 连接 |
| 2 | 执行 | 复用本机 `dispatchAndWait` / `agent-executor` → **投射应用**（与游乐场派发同一条链） |
| 3 | 上架 | **显式白名单勾选** + 勾选时校验 **已投射 ∩ runtime 可用** |
| 4 | 可见性 | **双通道**：全球公开 + 圈子内（对齐模型贡献心智） |
| 5 | 隐私 | **禁止**内容下载式点将；目录仅名片；接单只回产出 |
| 6 | 实现路径 | 选「扩展现有 worker WS」；不做独立通道、不做公网穿透 HTTP 主路径 |
| 7 | 一期非目标 | Skill/Prompt 单独贡献；对方本机 `tb_get_resource` 拉远程全文 |

---

## 3. 方案比选（摘要）

| 方案 | 结论 |
|---|---|
| 扩展现有 worker WS | **采用**：与模型分享同构，复用鉴权/圈子/结息 |
| 独立 `ws/agent-worker` | 否：双连接、贡献页心智分裂 |
| 目录 + 公网打到本机 dispatch | 否：穿透与安全重，不像模型分享 |

说明：Token Bank executor **本身就会驱动投射应用**，不是「另套 TB 壳」；贡献接单应直接复用该栈。

---

## 4. 角色与数据流

```
调用方 Token Bank / 社区入口
  → 后端路由（公开网 or 圈子）
  → 贡献者 worker（ws/worker）
  → agent-executor.dispatchAndWait(assistant:<id>)
  → 本机投射应用（Codex / Claude Code / …）
  → 产出回传 → 积分结息
```

| 角色 | 职责 |
|---|---|
| 贡献者 | 勾选武将、保持 worker 在线、本机真正执行 |
| 调用方 | 选社区/圈子武将、提交任务、消费积分、收结果 |
| 后端 | 注册名片、可见性过滤、派单、超时、结息 |
| 武将资源 | 仍只存在贡献者本地 DB；远端无全文副本 |

---

## 5. 贡献者侧（Contribute 页）

### 5.1 UI

在现有「贡献模型」旁增加 **「贡献武将」**：

- 列表：本机 `resources.type = assistant`
- 每行：显示名、runtime、投射目标、可用性（绿/灰）
- 勾选 + 可见性：`public` | `circle`（圈子沿用现有 `contribute_circle_ids`）
- 不可用原因明示：「未投射」「runtime 未安装」等

### 5.2 配置（建议落在 agent config）

```json
{
  "contribute_assistants": [
    {
      "id": "res-assistant-poem-expert",
      "visibility": "public"
    }
  ]
}
```

- 默认 **全关**（与模型勾选一致）。
- 保存前本地校验：投射存在 + `resolveAssistantRuntimeAgent` 可用。

### 5.3 Worker 注册 / 心跳

在现有 `regMsg` 上增加 `agents`（示例）：

```json
{
  "type": "register",
  "models": [ "…" ],
  "agents": [
    {
      "id": "res-assistant-poem-expert",
      "name": "poem-expert",
      "display_name": "写诗专家",
      "description": "短文案级简介",
      "tags": ["writing"],
      "visibility": "public",
      "runtime": "codex"
    }
  ],
  "circle_ids": [1, 2]
}
```

**禁止出现在上报中：** `soul`、prompt/skill 正文、API Key、本地绝对路径中的敏感段。

上线后若校验失败（取消投射 / 卸 runtime）：心跳应摘掉该将或标 `unavailable`，后端不再派单。

---

## 6. 调用方侧

### 6.1 发现

| 通道 | 入口（一期可最小） | 过滤 |
|---|---|---|
| 全球公开 | 供给源 / 网络「社区武将」列表 | `visibility=public` 且节点在线 |
| 圈子 | 圈子贡献 / 圈内武将列表 | 成员 ∩ `circle` 可见 |

名片字段：`id`（贡献者侧稳定 id）、`display_name`、`description`、`tags`、`runtime`、节点质量信号（可选：TTFT/成功率占位）。

### 6.2 调用语义

- **是**：发起远程 `agent_task`（任务自然语言 + 目标 assistant id + 节点）。
- **不是**：`tb_get_prompt` / `tb_get_resource` 拉取远程正文到本机点将。

UI 文案建议：「调用社区武将 · {名}（在对方设备执行）」——避免「下载智能体」。

### 6.3 结果

回传：`status`、文本产出摘要、可选文件清单元数据、用量占位。  
调用方会话展示结果；**不**把对方 soul 写进本地 resources。

---

## 7. WebSocket 协议扩展

### 7.1 下行：派单（后端 → worker）

```json
{
  "type": "agent_task",
  "task_id": "at-…",
  "assistant_id": "res-assistant-poem-expert",
  "prompt": "用户任务描述…",
  "timeout_ms": 600000,
  "circle_id": null,
  "caller_meta": { "user_id_hash": "…" }
}
```

### 7.2 上行：结果（worker → 后端）

```json
{
  "type": "agent_task_result",
  "task_id": "at-…",
  "status": "completed",
  "output": "…",
  "error": null,
  "usage": { "duration_ms": 12345 }
}
```

中间态（可选一期）：`agent_task_progress`（running / log tail）。

### 7.3 Worker 处理步骤

1. 查本地勾选名单含该 `assistant_id`。  
2. 再校验投射 + runtime；失败 → `rejected` + 原因。  
3. `dispatchAndWait("assistant:" + id, prompt, { mode: "worker", … })`。  
4. 回传结果；成功可记贡献侧「出租命中」（息票文案与自用区分）。

### 7.4 兼容

- 旧 worker 无 `agents` 字段：后端当空列表。  
- 旧后端不识 `agent_task`：worker 忽略或回 `unsupported`（握手能力位可选：`caps: ["agents"]`）。

---

## 8. 结息与费率

一期允许：

- 独立配置 `agent_contribute_rate` / `agent_consume_rate`，**或**  
- 暂挂到某一档模型费率（实现快），但 UI 须标明「武将任务 · 按次/按时长」。

记账类型建议与现有 `contribute` 区分或加 `meta.kind = "agent"`，便于盘点「昨夜：算力 + 武将被点」。

调用方余额不足：派单前拒；贡献者执行中失败：按现有任务失败策略不扣或退（与模型任务对齐，实现方案里写清）。

---

## 9. 与 Hit-or-Exit / 自用点将的关系

| 状态 | 治理 |
|---|---|
| 自用命中 | 现有息票 / use_count |
| 贡献接单成功 | 计「出租命中」；算流通中，**不因「自己没点将」误沉底** |
| 长期既无自用也无接单 | 仍可 Hit-or-Exit（催上架或冷藏） |
| 仅勾选贡献但从不上线 | 不算有效流通；可轻推「打开贡献」 |

自用 MCP 点将路径不变；贡献是 **第二条生命线（出租）**，不替代本地点将。

---

## 10. 安全

1. **正文不出户**：目录与协议无 soul/兵器全文。  
2. **输出侧**：可复用现有日志脱敏；不做「把完整对话写回调用方磁盘镜像」。  
3. **鉴权**：沿用 worker_key；圈子任务校验成员关系。  
4. **滥用**：超时、并发上限（可先与模型 worker 并发共用或略严）。  
5. **明示**：贡献页提示「任务在你电脑上跑，会占用本机 CLI/应用」。

---

## 11. 分期

### 一期（打通）

- [x] agent config + Contribute UI 勾选与校验  
- [x] worker 注册 `agents` + 处理 `agent_task`  
- [x] 后端：注册存储、公开/圈子列表、派单、结果、结息（可先借用费率档）  
- [x] 调用方最小入口：列表 + 发起任务 + 看结果  
- [ ] 贡献成功息票（出租文案）

### 二期

- 独立费率表、排队、节点优选、SLA  
- Skill/Prompt 单独贡献策略（仍须防泄漏，默认也应「远端执行」而非下载）  
- 贡献方审阅/拒绝策略 UI  
- 盘点页「算力 + 武将出租」合并叙事

---

## 12. 明确不做（一期）

- 社区目录下载武将供对方 `tb_get_resource`  
- 不校验投射/runtime 即允许贡献  
- 第二条 WebSocket  
- 用「纳管数量」代替「接单成功」算贡献成就  

---

## 13. 宣传与文案原则

| 避免 | 使用 |
|---|---|
| 分享智能体文件 / 下载武将 | 贡献武将算力 · 在你设备出战 |
| 资产上架广场 | 闲将接单换积分 |
| 对方本地启用包 | 远程点将任务 |

对外一句：

> 模型能分享，武将也能：闲着的将在你电脑上帮别人打仗，你拿积分——兵书不离营。

---

## 14. 开放问题（实现方案阶段再钉）

1. 一期结息按「次」还是「时长 / token 估算」？  
2. 调用方入口挂在「供给源·社区」还是独立「社区武将」页？  
3. `assistant_id` 跨用户碰撞时，路由键是否必须 `(worker_id, assistant_id)`？  
4. 贡献任务的工作目录 / 沙箱边界（默认贡献者 home 还是临时目录）？

---

## 15. 自检

- [x] 无「TBD 正文泄漏方案」：已明确禁止下载式点将  
- [x] 与武将库「自用 + 出租」双生命线一致  
- [x] 与模型贡献 WebSocket 同构，避免双通道  
- [x] 范围：一期 / 非目标分开  
- [x] 未把 Skill/Prompt 单独出租塞进一期必做  

---

**下一步：** 用户确认本文件后，再开 `writing-plans` 出实现 Task 清单；**确认前不写业务代码**。
