# 产品审查 · 对照「武将库/兵器库 · 自用可出租 · MCP 点将」

日期:2026-07-25  
完整产品设计:[武将库产品设计完整版](./2026-07-25-tokenbank-generals-product-design.md)  
对照逻辑:[武将库点将](./2026-07-25-general-roster-mcp-design.md) · [反笔记陷阱](./2026-07-25-anti-notes-trap-design.md) · [价值闭环](./2026-07-25-ai-asset-value-loop-design.md)

**一段话逻辑（审查标尺）：**

> Token Bank 存的是武将库（智能体）+ 兵器库（Skill/Prompt）；主公用 MCP 点将后同会话披甲作战；闲将闲兵可出租换积分；绝不能做成藏而不用的笔记库。

---

## 1. 能力映射

| 逻辑点 | 对齐 | 现状摘要 |
|---|---|---|
| 武将=assistant，兵器=Skill/Prompt | 半 | 数据三分型已有；UI/文案仍是「资产管理仓库」 |
| 自用：投射后主公可用 | 半 | Prompt MCP / Skill 落盘 / Assistant 进派发列表均有；缺「启用包=投射+口令」 |
| 出租：闲将/兵器换积分 | 错位 | 仅有**算力**社区分享结息；资源目录以下发为主，无用户上架出租 |
| 点将 MCP 同会话披甲 | **半→错位** | **已有** `tb_list_resources` / `tb_get_resource`；缺投射门控；get(assistant) 只给 preview 且 **hint 去 dispatch**（应改为全文出战） |
| 编排派发 | 已齐 | `tb_dispatch_agent(assistant:*)` + agent-executor 拉 runtime |
| Prompt 单件取用 | 已齐 | `tb_get_prompt` 同构样板，点将应对齐它 |
| 反裸收藏 | 错位 | CTA「纳管/已纳管」；允许 0 投射终态 |
| 成功=7 日命中 | 错位 | 无命中账；闲置清理偏 60 天、多仅 Skill、偏手动 |
| 场景路由≠武将 | 已齐 | 只管模型链/strategy，未与智能体混淆 |
| 宣传卖结果不卖库 | 偏错位 | 「资产管理」「先纳管进 Token Bank」仍是主叙事 |

**总判：** 底座（三分型、投射、Prompt MCP、算力路由、编排派发）已齐；核心落差是 **点将主路径未实现且被派发抢占，UI 仍是纳管型笔记库，出租只覆盖算力。**

---

## 2. 最像笔记软件的三处（优先拆）

1. **资源页主壳**（`Resources.jsx` + `pages-zh.js`）  
   「资产管理 / 先纳管再安装」+ 默认「已纳管」Tab → 主路径是整理库存。

2. **推荐卡 CTA**（`PersonalizedRecommend.jsx`）  
   「纳管」「已纳管到 Token Bank」→ 典型稍后读。

3. **用途标签墙 + 长周期闲置清理 + 画像晒能力**  
   方向有「清」，但仍以库为中心，易变成收藏秀。

---

## 3. 改进思路（按优先级）

### P0 — 先让「自用」打得穿

1. **增强现有 resources MCP（不新建 list）**（`resources-mcp.js`）  
   - `tb_list_resources`：assistant 按 `TB_CLIENT_ID` 投射过滤；文案标明武将  
   - `tb_get_resource(assistant)`：返回 `resolveAssistantContext` **全文**；**去掉「默认去 dispatch」hint**  

2. **能力叙事纠偏**（`tb-capabilities.js`、编排提示）  
   - 直连：`list(type=assistant)` → `get` → 同会话披甲  
   - 派发 = 仅游乐场/编排  

3. **纳管 → 启用包**（`Resources.jsx` / `PersonalizedRecommend.jsx` / 文案）  
   - CTA「启用到 {Cursor/Claude Code/…}」= 入库 ∧ 默认投射 ∧ 可复制口令  
   - 禁止 0 投射「已收藏」终态  

4. **`listAssistantsForClient`**（`resource-manager.js`）  
   - 与 `listPromptsForClient` 同级，供 list/get 门控  

### P1 — 流通与反囤积

5. **命中记账**  
   - activate / get_prompt / skill 使用 → `use_count` / `last_hit_at`  
   - 列表未命中沉底；出手周报/息票可后做  

6. **Hit-or-Exit**  
   - 48h 口令轻推；7 日取消默认投射；30 日休眠 → 冷藏或**上架出租**  
   - 清理范围扩到 assistant（不只 skill）  

7. **场景货架主故事**  
   - 推荐按「我要办的事」聚合；类型 Tab 降进阶  
   - 文案去「统一管理/资产库」，改「启用到… / 点将出战」  

### P2 — 「出租」补齐武将/兵器侧

8. **闲将/兵器上架**  
   - 用户可将闲置 assistant/skill/prompt 贡献目录或圈子，换积分（对齐算力贡献账户）  
   - 出租成功 = 被他人启用/点将，不是「挂着给人看」  

9. **`tb_suggest_general`** 自动举荐（引导命中率实测）  

10. **Contribute / 盘点叙事打通**  
    - 「昨夜：算力结息 + 武将被点 N 次」同一「出手」语言  

---

## 4. 模块级最小路径（执行清单）

| # | 改哪里 | 做什么 |
|---|---|---|
| 1 | `client/electron/resources-mcp.js` | 复用 list；get(assistant) 展开全文 + 改 hint |
| 2 | `client/electron/resource-assistant.js` / `resource-manager.js` | ForClient 列表/解析；复用 resolveAssistantContext |
| 3 | `client/electron/tb-capabilities.js` | 点将优先于派发的工作流文案 |
| 4 | `client/src/pages/Resources.jsx` + `locales/pages-zh.js` | 启用包 CTA、口令、去图书馆文案 |
| 5 | `client/src/components/PersonalizedRecommend.jsx` | 纳管→启用到…+口令 |
| 6 | `client/electron/agent-dispatch-mcp.js` | 描述限定「编排专用」 |
| 7 | 命中字段 + 清理模块 | 记账；阈值与 assistant 纳入 Hit-or-Exit |
| 8 | （P2）社区目录上架 API + UI | 武将/兵器出租换积分 |

---

## 5. 改进原则（审查时反复用）

1. 这屏是在帮用户**出战/出租**，还是在帮用户**整理收藏**？  
2. Cursor/Claude Code 能否**同会话点将**而不被导向派发？  
3. 闲置资产下一步是**被点将或上架**，还是继续待在「已纳管」里吃灰？  

做不到就还在笔记软件老路——打回。

---

## 6. 一句话改进纲领

> **点将不必新 MCP：把已有 `tb_list_resources` / `tb_get_resource` 做成将帅榜与出战全文；纳管改启用；派发降编排；出租补上武将/兵器——价值在流通，不在库存。**
