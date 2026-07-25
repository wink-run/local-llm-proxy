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

> **武将库 = 资产中的智能体列表。**  
> 点将 = 主公经 MCP 查询/激活某个 assistant，拿到其 soul + 关联 skill/prompt 正文（或编排派发），再开战。

此前草案里用「场景 → skill 集合」顶替武将——**作废**。场景路由继续只管算力；出战选的是智能体。

---

## 1. 比喻与硬约束

**比喻：** 武将库 · 出战时动态选将。

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

### 4.1 建议工具集（武将 = assistant）

| 工具 | 级别 | 作用 |
|---|---|---|
| `tb_list_generals` | 浏览 | 列出可点武将 = 可见 assistant：id / 显示名 / 擅长摘要 / 绑定 skill·prompt 数（轻量） |
| `tb_suggest_general` | **自动举荐** | `task_description`（+ cwd?）→ 候选 assistant[] + why |
| `tb_activate_general` | **显式点将** | 按 name / id / 别名激活；返回该智能体 **出战上下文文本**（soul + 关联 prompt 正文 + skill 指引） |

也可第一期薄封装现有能力：

- 浏览 ≈ `tb_list_resources({ type: 'assistant' })`（补强描述与「武将」引导）  
- 激活 ≈ `tb_get_resource` 强化版：对 assistant **展开** `resolveAssistantContext`，而非只给 JSON 摘要  

返回约定（安全路径）：

- ✅ 智能体出战文本（与现网 `resolveAssistantContext` 同类）  
- ✅ 可选：建议再调的 `tb_get_prompt` / skill 名（仍由模型自己调）  
- ❌ 不注册新 tool schema、不改写请求 `tools`  
- ❌ 不把「场景路由」的 model_key 当成武将 id  

### 4.2 点将 vs 派发

| | **点将** `tb_activate_general` | **派发** `tb_dispatch_agent` |
|---|---|---|
| 谁打仗 | **主公自己打**，读武将兵书 | **武将下场打**，主公等结果 |
| 典型 | Cursor 会话里「按代码审查智能体那套来」 | 游乐场编排：主 Agent 把子任务交给 `assistant:…` |
| 载荷 | 上下文文本 | 子 Agent 执行（TB `agent-executor` 拉起 runtime CLI） |

两条都是「主公下令」，都不是网关塞将。P0 先打通**点将**（直连会话最高频）；派发已有 bridge，对齐文案与举荐即可。

### 4.2.1 Cursor 点将：是不是「拿 soul 再开子智能体」？

**不是 Token Bank 替 Cursor 再开一个子智能体。**

Cursor 直连会话里的默认路径是 **披甲自己打**：

```
Cursor 当前 Agent（主公）
  → MCP: tb_activate_general("某智能体")
  → 拿到一段文本：soul + 绑定 prompt 正文 + skill 指引
  → 仍在同一个 Cursor 会话里，按这段文本继续推理 / 改代码 / 调自己的工具
```

| 误解 | 实际 |
|---|---|
| TB 收到点将后 spawn 一个新 Cursor/Claude 进程 | ✗ 点将只 **返回文本**，不拉进程 |
| Cursor 必须再「创建子 Agent」才能用武将 | ✗ **不必须**；当前对话里消化兵书即可 |
| 武将 = 独立运行的子智能体实例 | ✗ 点将视角下武将 = **可加载的人设+兵书包** |

补充：

1. **Cursor 自己**若用 Composer/Task 再开子 Agent，那是 Cursor 产品行为，TB 不保证、不依赖。  
2. **只有派发路径**才会由 TB 拉起 runtime（含 `cursor-agent` CLI），把 soul 做成 `promptPrefix` 交给新进程——那是游乐场编排，不是 IDE 里点将 MCP 的默认语义。  
3. Skill 若已投射进 `~/.cursor/skills`，Cursor 可按自家 Skill 机制用；与 `tb_activate_general` 返回的 skill **指引文本**可并存，但点将不等于「再 fork 一个挂了该 skill 的子 Agent」。

### 4.3 与现有 MCP

| 已有 | 关系 |
|---|---|
| `tb_list_resources` / `tb_get_resource` | 武将库底座；点将 = assistant 的出战视图 |
| `tokenbank-prompts` | 兵书单件取用；激活武将时可内联其 `prompts[]` |
| `tokenbank-agent-bridge` | 派发路径；`tb_list_agents` 应与将帅榜一致（assistant 优先） |
| `tb_capabilities` | 增加「武将 = 智能体；点将工具；何时查将」 |

**落位：** P0 扩展 `tokenbank-resources`（或薄包装 `tb_list_generals` / `tb_activate_general`），数据只读 assistant；勿新建与智能体平行的「场景武将」表。

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

未投射的 assistant：`tb_list_generals` 不出现，`tb_activate_general` 拒绝——与 prompt 投射一致。

### 会话内调用（模型主动，零侵入）

**显式点将（主路径）：**

```
用户对 Claude Code / Codex：
  「上代码审查那个智能体」/「用调试武将」

→ 模型发现 MCP 工具 tb_activate_general（或先 tb_list_generals）
→ 调用 tb_activate_general({ name: "代码审查" })
→ tokenbank-resources（stdio）按 TB_CLIENT_ID 校验投射
→ 返回该 assistant 出战文本（soul + 绑定 prompt 正文 + skill 指引）
→ 模型把返回内容当补充上下文，自己继续干活
```

**自动举荐：**

```
模型判断任务偏专业
→ tb_suggest_general({ task_description: "…" })
→ 得到候选武将列表 → 再 activate 或告诉用户选哪个
```

**和今天 Prompt 的对照（帮助建立直觉）：**

| | Prompt（已有） | 武将 / 智能体（本设计） |
|---|---|---|
| 用户怎么说 | 「用某某 prompt 做…」 | 「用某某智能体/武将做…」 |
| 模型调什么 | `tb_list_prompts` → `tb_get_prompt` | `tb_list_generals` → `tb_activate_general` |
| 拿到什么 | 单条提示词正文 | 智能体 soul + 绑定兵书 |
| 谁执行 | Claude Code / Codex 自己 | 同上（点将路径） |

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

### 5.1 自动举荐 · `tb_suggest_general`

```
主公读到任务 → 判断需专业智能体
  → tb_suggest_general({ task_description, cwd? })
  → 基于 assistant 描述 / 用途标签 / 历史点将（+ 可选 embedding）
  → [{ id, name, why, skill_count, prompt_count }]
  → 主公再 tb_activate_general 或 tb_dispatch_agent
```

### 5.2 显式点将 · `tb_activate_general`（早期主入口）

用户：「上代码审查那个智能体」「用调试武将」「切到写作助手」。

```
主公 → tb_activate_general("代码审查")  // name / display_name / 别名
     → 返回该 assistant 的出战上下文（soul + prompts 正文 + skills 指引）
     → 主公按上下文执行
```

- 绕开「猜该上谁」  
- 口令 = 智能体显示名（启用包教用户喊将）  
- **早期验证主路径**

---

## 6. 软层：让主公愿意翻将帅榜

常驻指引（capabilities + 短 hint，走现有同步，不破协议）：

> 资产中的智能体是可点武将。任务需要专业角色、或用户点名某智能体/武将时，先 `tb_list_generals` / `tb_suggest_general` / `tb_activate_general`；不要臆造该智能体的 soul 与流程。简单事不必点将。

指标：应点将任务的主动查询率、误查率、显式点将成功率、点将后轮次下降。

---

## 7. 与其它块的咬合

| 块 | 咬合 |
|---|---|
| 反笔记陷阱 | 智能体不是收藏；**启用到主公 + 一次点将命中**才算成功 |
| 场景货架 | 货架条目若指向智能体：CTA「启用到 Cursor」= 投射该 assistant + 教喊将口令 |
| 息票 | `tb_activate_general` / 派发命中记「点将」 |
| 投射门控 | 仅投射给当前主公的 assistant 出现在将帅榜（与 prompt 投射同理） |
| Skill/Prompt | 可单独启用；在点将叙事里是武将装备，主货架仍可按「事」聚合到某智能体 |

---

## 8. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| 0 | **武将本体** | **= 资产中的智能体（assistant）**；Skill/Prompt 是兵书 |
| 1 | 出战控制权 | 主公（客户端模型）点将；MCP 只应答 |
| 2 | 载荷 | 智能体出战文本（soul+绑定资源），不改 tool schema |
| 3 | 早期主路径 | 显式 `tb_activate_general` |
| 4 | 自动举荐 | `tb_suggest_general` 第二阶段 |
| 5 | 派发 | 保留 `tb_dispatch_agent(assistant:…)`，与点将分工 |
| 6 | 场景路由 | 只管算力，不进武将库 |
| 7 | 每轮强制选将 | **不做** |

---

## 9. 实现切片

### P0 — 显式点将可演示

1. `tb_list_generals` = 可见 assistant 轻量列表（投射门控）  
2. `tb_activate_general` = 展开 `resolveAssistantContext` 级正文  
3. `tb_capabilities` 写明：武将 = 智能体  
4. 实测：用户喊智能体显示名 → Cursor / Claude Code 调工具拿回 soul  

### P1 — 自动举荐

1. `tb_suggest_general(task_description, cwd?)`  
2. 引导 A/B；与 `tb_list_agents` 举荐口径对齐  

### P2 — 流通

1. 点将命中 → 息票 / `use_count`（记在 assistant 上）  
2. 货架启用智能体 = 投射 + 口令  
3. 从未被点将的智能体走 Hit-or-Exit  

---

## 10. 非目标

- 另建与 assistant 平行的「场景武将」实体  
- 网关注入 tools / system  
- 把模型场景路由当成选将器  
- 把 Skill 列表当成武将库首页（那是兵器架，不是将帅榜）  

---

## 11. 一句话

> **武将就是资产里的智能体；主公用 MCP 点将，兵书（Skill/Prompt）随将出战——网关不抢指挥权，零侵入。**
