# 武将库出战 · MCP 点将 —— 设计文档

日期:2026-07-25  
状态:已定方向（使用时创意 · 零侵入）  
相关:[反笔记陷阱](./2026-07-25-anti-notes-trap-design.md) · [Prompt 资产走 MCP](./2026-07-11-prompt-assets-mcp-only-design.md) · [价值闭环](./2026-07-25-ai-asset-value-loop-design.md)

---

## 0. 本体对齐（重要更正）

| 角色 | 产品实体 | 说明 |
|---|---|---|
| **武将** | 资源里的 **智能体**（`resources.type = 'assistant'`） | 有 soul、绑定 skills / prompts / mcp、可投射到运行时 |
| **兵书 / 装备** | Skill、Prompt（及智能体声明的 MCP） | 挂在武将身上；点将时随将出战，**本身不是武将** |
| **主公** | 运行时客户端 Agent（Claude Code / Cursor / Codex…） | 点将的人；武将不能自己冲上去 |
| **算力路** | Gateway **场景路由**（模型链 / strategy） | 选哪条路跑模型；**不是**武将库 |

> **Token Bank 里存的，就是武将库 + 兵器库。**  
> - **武将库** = 智能体（assistant）  
> - **兵器库** = Skill / Prompt /（声明的）MCP  
> 点将 = 主公经 MCP 激活某个武将，兵书随将出战（或编排派发）。

此前草案里用「场景 → skill 集合」顶替武将——**作废**。场景路由继续只管算力；出战选的是智能体。

### 自用 · 出租（资产双用途）

| 用途 | 含义 | 产品落点（现有/延伸） |
|---|---|---|
| **自用** | 主公点将，披甲打仗 | 投射 + `tb_activate_general` / 派发 |
| **出租** | 闲置武将/兵器/算力借给圈子或社区，换积分 | 目录贡献、圈子共享；算力侧已有社区分享结息 |

约束（防又变收藏夹）：

- 出租的应是**流通中的能力**（可被别人点将/调用），不是晒库存  
- 自用优先命中；长期未自用也未出租 → Hit-or-Exit（冷藏 / 真删 / 上架出租）  
- 宣传：**「养得起一支能出战也能出租的队伍」**，不是「我收藏了多少将」

一段话（对外）：

> 你的 Token Bank 就是私人武将库与兵器库：智能体是将，Skill/Prompt 是兵器；平时自己点将出战，闲着的将与兵器还可以出租给社区换积分——存的是能打仗、能生息的队伍，不是吃灰的收藏夹。

---

## 1. 比喻与硬约束

**比喻：** 武将库 / 兵器库 · 出战时点将 · 闲时出租。

**硬约束：**

> **武将不能自己冲上去打，得等主公（客户端 / 模型）点将。**

推论：

| 禁止 | 允许 |
|---|---|
| 网关改写客户端工具协议、篡改请求体塞 tool schema | 武将库做成 **MCP server**，主公主动发现并调用 |
| 每轮强制猜「该上哪个智能体」 | 模型自愿查将 / 用户显式点将 |
| 网关单方面注入 assistant soul | 返回 **智能体上下文文本**（soul + 绑定 prompt/skill 说明），由模型采纳 |

一句话：

> **出战钥匙铸成 MCP 工具挂在主公腰上；库里的智能体是将，Skill/Prompt 是兵书——点将才出战。**

与 `tokenbank-prompts`、`tb_list_resources(type=assistant)` 同构；满足反笔记陷阱：**用的时候召将，不是囤一堆智能体当收藏。**

---

## 2. 命名澄清

| 词 | 含义 | 本设计 |
|---|---|---|
| **智能体 / assistant** | 资产资源类型 | **= 武将** |
| **Skill / Prompt** | 资产资源类型 | 武将携带的兵书；可被单独取用，但选将视角以智能体为聚合单位 |
| **场景路由** | 模型供给 failover | **不动**；与点将正交 |
| **点将** | 主公 MCP 调用 | 查询 / 激活某个 assistant |
| **派发** | `tb_dispatch_agent` | 编排时把整场仗交给另一武将去打（仍由主公下令） |

对外可说「点将 / 换个智能体」；对内 id 继续 `assistant:<resourceId>` / 资源 `name`。

---

## 3. 核心转向：网关注入 → 客户端可查询的将帅榜

```
旧思路（踩雷）
  用户请求 → 网关猜场景 → 注入 system / 改 tools → 客户端被迫执行

新思路（零侵入）
  用户请求 → 主公（模型）推理
                ├─ 通用活 → 自己干（不点将）
                └─ 要专业智能体 / 用户点名
                         → MCP 查武将库（assistant 列表）
                         → 激活：拿回该智能体 soul + skills/prompts 正文
                         → 或编排：tb_dispatch_agent(assistant:…)
                         → 主公决定是否采纳 / 是否派发
```

武将库数据源 = 已纳管且（对当前主公）已投射可见的 **assistant** 资源；  
出战载荷复用现有 `parseAssistantConfig` + `resolveAssistantContext` 思路（soul ∥ 绑定 prompts 正文 ∥ skills 清单）。

---

## 4. 工具形态

### 4.1 复用现有 `tokenbank-resources`（不另造 list）

**已有就够当将帅榜入口的工具：**

| 已有工具 | 武将库语义 | P0 改动 |
|---|---|---|
| `tb_list_resources` | **浏览武将/兵器库**；`type=assistant` 即点将前的将帅榜 | 文案写明「assistant=武将」；按 `TB_CLIENT_ID` **投射过滤**（对齐 prompt）；可选强化 `query` |
| `tb_get_resource` | **显式点将（主路径）** | `type=assistant` 时改为返回 **`resolveAssistantContext` 全文**（soul+绑定 prompt/skill），不再只给 400 字 preview；hint 改为「同会话按正文执行；仅编排才 `tb_dispatch_agent`」 |
| `tb_list_catalog` | 未纳入的出租/目录货架（发现用） | 文案可带「需用户在 TB 启用」；本工具仍不安装 |
| `tb_capabilities` | 教会主公何时 list/get 武将 | 工作流：`list(type=assistant)` → `get` → 自打；派发放后 |

**不新增** `tb_list_generals`（与 `tb_list_resources` 重复）。  

**可选新增（非 P0）：**

| 工具 | 何时加 |
|---|---|
| `tb_suggest_general(task_description)` | P1 自动举荐；内部仍读同一批 assistant |
| `mode` 参数 on `tb_get_resource` | 若需兼容「只要 JSON 摘要」的调用方：`mode=summary\|activate`（默认 `activate`） |

返回约定（assistant 点将）：

- ✅ 出战文本（`resolveAssistantContext`）  
- ✅ 文首可附一行 `dispatch_id: assistant:…`（编排备用）  
- ❌ 不改客户端 tool schema、不拉子进程  

### 4.2 点将 vs 派发

| | **点将** `tb_get_resource(type=assistant)` | **派发** `tb_dispatch_agent` |
|---|---|---|
| 谁打仗 | **主公自己打**，读武将兵书 | **武将下场打**，主公等结果 |
| 典型 | Cursor：`list` → `get` 某智能体 → 同会话执行 | 游乐场编排 |
| 载荷 | 上下文文本 | 子 Agent 执行（TB agent-executor） |

P0 = **改现有 get 的 assistant 分支 + 门控 + 文案**；不新开 MCP server。

### 4.2.1 Cursor 点将：是不是「拿 soul 再开子智能体」？

**不是。** 默认 **披甲自己打**：

```
Cursor
  → tb_list_resources({ type: "assistant", query? })
  → tb_get_resource({ type: "assistant", name: "代码审查" })
  → 拿到 soul + 兵书文本
  → 仍在同一会话执行
```

| 误解 | 实际 |
|---|---|
| TB 点将后 spawn 新进程 | ✗ 只返回文本 |
| 必须再开 Cursor 子 Agent | ✗ 不必须 |
| 要新 MCP 才能列武将 | ✗ **已有** `tb_list_resources` |

派发拉起 `cursor-agent` CLI 仅编排路径。

### 4.3 与现有 MCP

| 已有 | 关系 |
|---|---|
| **`tokenbank-resources`** | **武将库/兵器库唯一发现面**；点将 = 增强后的 get(assistant) |
| `tokenbank-prompts` | 单件兵器；武将 get 时可内联其 prompts[] |
| `tokenbank-agent-bridge` | 仅编排派发 |
| `tb_capabilities` | 写明复用 list/get，勿引导先去 dispatch |

---

## 4.4 Claude Code / Codex 怎么调用（直连会话）

二者都是 **MCP client**，不改它们的协议；Token Bank 只把 MCP 写进各自配置，会话里由模型按工具描述自行调用——与今天 `tb_get_prompt` 完全同构。

### 配置落点（已有 sync）

| 主公 | 配置文件 | 格式 | `TB_CLIENT_ID` |
|---|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers` | JSON | `claude-code` |
| Codex | `~/.codex/config.toml` | TOML | `codex` |

`mcp-client-sync` 物化内置 server（如 `tokenbank-resources` / 点将工具所在 MCP）时带上：

- stdio 启动：`process.execPath` + 脚本绝对路径 + `ELECTRON_RUN_AS_NODE`
- env：`TB_CLIENT_ID=claude-code` 或 `codex`（投射门控按主公过滤武将）

### 用户侧前置（启用包）

1. 资源页把智能体（武将）**投射到** Claude Code 和/或 Codex  
2. 触发 re-sync → 该主公配置里出现点将 MCP  
3. 教一句口令（显示名）：「用『代码审查』智能体审查当前分支」  

未投射的 assistant：`tb_list_resources(type=assistant)` 不出现；`tb_get_resource` 拒绝——与 prompt 投射一致。

### 会话内调用（模型主动，零侵入）

**显式点将（主路径 = 已有 list/get）：**

```
用户对 Claude Code / Codex / Cursor：
  「上代码审查那个智能体」/「用调试武将」

→ tb_list_resources({ type: "assistant", query: "审查" })   // 已有
→ tb_get_resource({ type: "assistant", name: "代码审查" }) // 增强：全文出战上下文
→ 按 TB_CLIENT_ID 校验投射 → 返回 soul + 兵书
→ 模型同会话继续干
```

**自动举荐（P1，可选新工具）：** `tb_suggest_general` → 再 `tb_get_resource`。

**和今天 Prompt 的对照：**

| | Prompt（已有） | 武将 / 智能体 |
|---|---|---|
| 用户怎么说 | 「用某某 prompt」 | 「用某某智能体/武将」 |
| 模型调什么 | `tb_list_prompts` → `tb_get_prompt` | **`tb_list_resources(assistant)` → `tb_get_resource`** |
| 拿到什么 | 提示词正文 | soul + 绑定兵书 |
| 谁执行 | 主公自己 | 主公自己 |

### 编排派发（另一条，主公仍是下令方）

仅当走 Token Bank 游乐场 / 编排、且注入了 `tokenbank-agent-bridge` 时：

```
主 Agent → tb_list_agents（assistant:* 优先）
        → tb_dispatch_agent({ agent_id: "assistant:…", prompt: "…" })
        → 武将在对应 runtime 里下场执行，主公汇总
```

日常在终端里开的 **Claude Code / Codex 直连会话**，默认走 **点将（激活上下文）**，不强制派发——避免用户以为「点了将人却换了个进程」。

### 用户无感 checklist

- 不用改 Claude Code / Codex 命令  
- 不用手写 MCP JSON（TB 投射后 sync）  
- 不用懂 tool schema；会说话点将即可  
- 简单闲聊模型可不调工具 → 无额外延迟  

---

## 5. 两级点将

### 5.1 自动举荐 · `tb_suggest_general`（P1）

内部仍查同一批已投射 assistant；返回候选后再走 `tb_get_resource`。P0 可先靠 `tb_list_resources` + `query` + 引导措辞顶住。

### 5.2 显式点将 · `tb_get_resource(type=assistant)`（早期主入口）

用户：「上代码审查那个智能体」「用调试武将」。

```
主公 → tb_list_resources({ type: "assistant" })  // 可选
     → tb_get_resource({ type: "assistant", name: "代码审查" })
     → 出战全文 → 同会话执行
```

口令 = 智能体显示名（启用包教用户喊将）。

---

## 6. 软层：让主公愿意翻将帅榜

常驻指引（capabilities + 短 hint）：

> 智能体是可点武将。需要专业角色或用户点名时，用 `tb_list_resources(type=assistant)` 查找，再用 `tb_get_resource` 取回出战正文并按之执行；不要臆造 soul。简单事不必点将。仅在编排派发时才用 `tb_dispatch_agent`。

指标：应点将任务的主动查询率、误查率、显式点将成功率、点将后轮次下降。

---

## 7. 与其它块的咬合

| 块 | 咬合 |
|---|---|
| 反笔记陷阱 | 智能体不是收藏；**启用到主公 + 一次点将命中**才算成功 |
| 场景货架 | 货架条目若指向智能体：CTA「启用到 Cursor」= 投射该 assistant + 教喊将口令 |
| 息票 | `tb_get_resource(assistant)` / 派发命中记「点将」 |
| 投射门控 | 仅投射给当前主公的 assistant 出现在将帅榜（与 prompt 投射同理） |
| Skill/Prompt | 可单独启用；在点将叙事里是武将装备，主货架仍可按「事」聚合到某智能体 |

---

## 8. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| 0 | **武将本体** | **= 资产中的智能体（assistant）**；Skill/Prompt 是兵书 |
| 1 | 出战控制权 | 主公（客户端模型）点将；MCP 只应答 |
| 2 | 载荷 | 智能体出战文本（soul+绑定资源），不改 tool schema |
| 3 | 早期主路径 | **复用** `tb_list_resources` + 增强 `tb_get_resource(assistant)` |
| 4 | 不新增 list 工具 | **禁止**再造 `tb_list_generals` |
| 5 | 自动举荐 | `tb_suggest_general` 可选 P1 |
| 6 | 派发 | 保留 `tb_dispatch_agent`，降为编排 |
| 7 | 场景路由 | 只管算力 |
| 8 | 每轮强制选将 | **不做** |

---

## 9. 实现切片

### P0 — 在现有 resources MCP 上打通点将

1. `tb_list_resources`：assistant 按 `TB_CLIENT_ID` 投射过滤；description 写明武将语义  
2. `tb_get_resource(assistant)`：返回 `resolveAssistantContext` 全文；hint 改为同会话执行优先  
3. `tb_capabilities`：list→get→自打；dispatch 置后  
4. 单测：改 `resources-mcp.test.js`（assistant 不再只断言 JSON preview）  
5. 实测：喊显示名 → Cursor/Claude Code/Codex 走 list/get 拿回 soul  

### P1 — 自动举荐 / summary 兼容

1. 可选 `tb_suggest_general` 或 get 的 `mode=summary|activate`  
2. 引导 A/B  

### P2 — 流通

1. get(assistant) 命中 → `use_count`  
2. 启用包 + Hit-or-Exit + 出租  

---

## 10. 非目标

- **新建与 `tb_list_resources` 重复的 list 工具**  
- 另建与 assistant 平行的「场景武将」实体  
- 网关注入 tools / system  
- 把模型场景路由当成选将器  

---

## 11. 一句话

> **武将库就是现有资源 MCP：`tb_list_resources` 点将榜，`tb_get_resource(assistant)` 取兵书出战——补门控与全文，不另起炉灶。**
