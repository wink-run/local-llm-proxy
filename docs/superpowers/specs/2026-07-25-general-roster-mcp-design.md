# 武将库出战 · MCP 点将 —— 设计文档

日期:2026-07-25  
状态:已定方向（使用时创意 · 零侵入）  
相关:[反笔记陷阱](./2026-07-25-anti-notes-trap-design.md) · [Prompt 资产走 MCP](./2026-07-11-prompt-assets-mcp-only-design.md) · [价值闭环](./2026-07-25-ai-asset-value-loop-design.md)

---

## 1. 比喻与硬约束

**比喻（准）：** 武将库 · 出战时动态选将。

**硬约束：**

> **武将不能自己冲上去打，得等主公（客户端 / 模型）点将。**

推论：

| 禁止 | 允许 |
|---|---|
| 网关改写客户端工具协议、篡改请求体塞 tool schema | 把武将库做成 **MCP server**，客户端主动发现并调用 |
| 每轮强制跑场景判断加延迟 | 模型自愿多走一步推理才查库 |
| 网关单方面「注入」skill / 系统提示 | 返回 **skill 正文 / instruction 文本**，由模型当补充上下文采纳 |

一句话：

> **出战钥匙不能攥在网关手里，得铸成 MCP 工具挂在客户端腰上——模型自己决定何时拔出来用。**

这与现有 `tokenbank-prompts`（`tb_list_prompts` / `tb_get_prompt`）是同一安全路径；也满足反笔记陷阱：**用的时候才召将，不是先囤一库再盼奇迹。**

---

## 2. 命名澄清（避免与「场景路由」撞车）

| 现有词 | 含义 | 本设计 |
|---|---|---|
| **场景路由**（Gateway） | 模型供给链 / strategy failover（`scenes.default.yaml`） | **不动**；仍是选「哪条算力路」 |
| **武将 / 场景智能体** | 面向任务的 skill / prompt / assistant 组合 | **本设计对象**：选「带哪套本事出战」 |
| **点将** | 客户端模型调用 MCP 查询/激活武将 | 新能力域 |

对外文案可用「点将 / 出战模式」；对内工具前缀继续 `tb_`，实现可挂在新 MCP 或扩展 `tokenbank-resources`。

---

## 3. 核心转向：网关注入 → 客户端可查询的将帅榜

```
旧思路（踩雷）
  用户请求 → 网关猜场景 → 改写 tools / 注入 system → 客户端被迫执行
                              ✗ 协议侵入 · 每轮延迟 · 决策权错位

新思路（零侵入）
  用户请求 → 客户端模型推理
                ├─ 觉得简单 → 直接干（不查将）
                └─ 觉得专业 / 用户点名 → 调 MCP 点将工具
                         → TB 武将库被动应答（候选 + skill 正文）
                         → 模型自行决定是否采纳
```

Claude Code / Cursor 作为 MCP client，原生支持「发现工具 → 按需调用」。  
**不需要它们做任何额外改动；也不需要网关碰工具协议。**

---

## 4. 工具形态（草案）

复用 Prompt MCP 模式：stdio MCP + 投射/同步到 Agent + 描述驱动模型调用。

### 4.1 建议工具集

| 工具 | 级别 | 作用 |
|---|---|---|
| `tb_list_generals`（或 `tb_list_available_skills` 场景视图） | 浏览 | 列出可点武将：id / 名 / 擅长 / 关联 skill 数（轻量，无长正文） |
| `tb_suggest_scene` | **自动举荐** | 入参 `task_description`（+ 可选 cwd）；返回候选武将 + skill 摘要列表 |
| `tb_activate_scene` | **显式点将** | 入参 `scene`（如 `debug` / `writing` / 显示名）；返回该场景 skill **instruction 正文**集合 |

返回内容约定（安全路径）：

- ✅ skill / prompt 的 **文本指令**（与 `tb_get_prompt` 同类）  
- ✅ 可选：建议的后续工具名（仍由模型自己调现有 MCP）  
- ❌ 不返回、不要求客户端注册新的 tool schema  
- ❌ 不改写当前请求的 `tools` 数组  

### 4.2 与现有 MCP 的关系

| 已有 | 关系 |
|---|---|
| `tokenbank-prompts` | 单条 prompt 取用；点将可内部复用 `resolvePromptForClient` |
| `tokenbank-resources` | `tb_list_resources` / `tb_get_resource` 已是「库」雏形；武将是**按场景聚合的出战视图** |
| `tokenbank-agent-bridge` | 编排派发（`tb_dispatch_agent`）是「把活分给别的将军」；点将是「给当前主公增补兵书」——互补，勿合并 |
| `tb_capabilities` | 总览中增加「点将」域与推荐工作流一步 |

**落位偏好（已定倾向）：**

1. **P0** 在 `tokenbank-resources`（或新建轻量 `tokenbank-generals`）增加 `tb_suggest_scene` / `tb_activate_scene`  
2. 将帅元数据可来自：已投射 skill/prompt 的用途标签、assistant 配置、显式「场景 → skill[]」表（后续）  
3. 模型路由场景（综合最优等）**不**塞进武将库，避免两套「场景」语义污染  

---

## 5. 两级点将

### 5.1 自动举荐 · `tb_suggest_scene`

```
模型读到用户任务
  → 判断「可能需要专业本事」
  → tb_suggest_scene({ task_description, cwd? })
  → 网关/本地：目录线索 + 历史模式 +（可选）embedding 相似
  → 返回 [{ general_id, name, why, skills: [{name, summary}] }]
  → 模型决定采纳哪些 → 再 tb_activate_scene / tb_get_resource / tb_get_prompt 取正文
```

- 决策权全程在客户端模型  
- TB 只做**被动智库**  
- 延迟：仅在模型自愿调用时发生，不均摊到所有请求  

### 5.2 显式点将 · `tb_activate_scene`（早期主入口）

用户说：「用调试武将」「切到写作模式」「按代码审查那套来」。

```
模型 → tb_activate_scene("debug")
     → 返回该场景绑定的 skill/prompt 正文列表
     → 模型按正文执行
```

- **绕开「网关猜场景」**这个最不确定环节  
- 可靠性最高  
- **早期验证与兜底主路径**；自动举荐在命中率达标后再加戏  

口令与反笔记「一句话用法」对齐：启用场景时直接教用户怎么喊将。

---

## 6. 唯一允许触碰的「软层」：教会模型愿意查将

机制成不成，取决于模型是否主动调用工具。只允许一处引导（且走现有 Prompt MCP / 投射机制，不算破协议）：

**常驻指引（写入 capabilities 总览 + 可选短 system hint，经已有同步通道）：**

> 当你判断当前任务超出通用发挥、或用户提到模式/武将/专业做法时，先用 `tb_suggest_scene` 或 `tb_activate_scene` 查询 Token Bank 武将库；不要臆造专业流程。简单寒暄与单步小事无需查将。

打磨指标（软性变量，需实测）：

| 指标 | 含义 |
|---|---|
| 应查将任务的主动查询率 | 引导是否够显眼 |
| 误查率（简单任务也查） | 引导是否过猛 |
| 显式点将成功率 | 名字/别名是否好记 |
| 查将后任务轮次下降 | 价值是否兑现（反囤积） |

---

## 7. 与「使用时创意」其它块的咬合

| 块 | 咬合方式 |
|---|---|
| 反笔记陷阱 | 武将不是收藏夹；**出战=命中**；未点将的库存不占主路径 |
| 场景货架 / 启用包 | UI「启用到 Agent」= 投射 + 同步点将 MCP + 教一句显式口令 |
| 今日息票 | `tb_activate_scene` / suggest 被采纳并执行后记一笔「点将命中」 |
| 制卡投射 | 武将对 Agent 可见仍受投射门控（与 prompt 一致），防越权点将 |
| 模型侧场景路由 | 继续管算力；武将管本事——主公先点将，再走路 |

---

## 8. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 出战控制权 | **客户端模型点将**；网关/本地 MCP 只应答 |
| 2 | 载荷 | **skill/prompt 文本**，不改 tool schema |
| 3 | 早期主路径 | **显式点将** `tb_activate_scene` |
| 4 | 自动举荐 | `tb_suggest_scene` 第二阶段；靠引导调命中率 |
| 5 | 协议 | 零侵入；复用 MCP client 原生能力 |
| 6 | 每轮强制场景识别 | **不做** |
| 7 | 与模型场景路由 | **分离**；勿混名混配置 |

---

## 9. 实现切片（建议）

### P0 — 显式点将可演示

1. 定义最小场景表：`debug` / `writing` / `review` … → skill/prompt id 列表（可先写死 + 本地配置）  
2. MCP 工具 `tb_list_generals` + `tb_activate_scene`  
3. `tb_capabilities` / 常驻 hint 增加点将指引  
4. 投射门控：仅已对当前 `TB_CLIENT_ID` 可见的资源可被激活  
5. 实测：用户说「用调试武将」时 Claude Code / Cursor 能否稳定调工具  

### P1 — 自动举荐

1. `tb_suggest_scene(task_description, cwd?)`  
2. 启发式：用途标签 + 工作目录线索 + 近历史点将  
3. 引导措辞 A/B，盯主动查询率与误查率  

### P2 — 流通与认知

1. 点将命中写入息票 / `use_count`  
2. UI 场景货架 CTA：「启用并教会口令」  
3. 未点将的沉睡武将走 Hit-or-Exit（与反陷阱一致）  

---

## 10. 非目标

- 网关在 `/v1/chat/completions` 里注入或剥离 tools  
- 把模型「场景路由」改造成武将选择器  
- 强制每轮 embedding 场景分类  
- 让武将库变成又一个要整理的笔记库首页  

---

## 11. 一句话

> **武将库是挂在客户端腰上的 MCP 钥匙串：主公点将才出战，网关只配兵书不抢指挥权——零侵入、按需延迟、决策权归模型。**
