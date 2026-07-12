# 社区推荐资源服务器下发 —— 设计文档

日期:2026-07-12
分支:cursor/agent-aggregation-system-e85f

## 背景与目标

MCP / Skill / Prompt / Agent(assistant)四类「社区推荐」资源目前是**客户端内置静态数据**:

| 资源 | 当前来源 | 是否服务器下发 |
|---|---|---|
| Provider / billing_sources | server registry.yaml + DB 覆盖 → `GET /api/catalog` → [catalog-sync.js](../../../client/electron/catalog-sync.js) 写 `~/.tokenbank/providers.registry.yaml` | ✅ 已下发 |
| App 纳管目录 | `config.app_catalog` publish | ✅ 已下发 |
| **MCP 目录** | [config/mcp-catalog.yaml](../../../client/electron/config/mcp-catalog.yaml) 本地静态 | ❌ 内置 |
| **Prompt / Skill / Assistant 目录** | [resource-catalog.js](../../../client/electron/resource-catalog.js) 硬编码 `BUILTIN_CATALOG` | ❌ 内置 |

**目标**:把这四类推荐目录改为**服务器下发**,照搬已存在的 provider catalog 链路——
`admin 发布 → 服务端 yaml/DB → 公开 endpoint → 客户端后台 sync 落缓存 → UI 读缓存,内置做兜底`。
运营改推荐列表无需发新版客户端。

**非目标**:不改现有「投射(client→agent)」逻辑;不做自动安装/自动投射;不做专用 admin 编辑 UI。

## 已定决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 下发粒度 | **清单 + 完整正文**:skill/prompt/assistant 连 `content` 一起下发,MCP 下发完整配置模板(与 provider catalog 下发完整字段一致) |
| 2 | 运营编辑能力 | **YAML 默认 + DB 覆盖 + publish**:照搬 routing/app catalog 的 publish 模式,暂不做专用 admin 编辑 UI |
| 3 | 应用方式 | **只更新「可选推荐列表」,用户手动装**:server 下发只刷新客户端市场/目录,用户仍在 UI 点 install 才纳管,再自行投射;不侵入用户环境 |

## 核心原则

> **服务器下发的是「可选推荐清单」,不是「已安装状态」。** 它只替换客户端市场里能看到的候选项,安装与投射仍由用户手动触发。离线时用缓存或内置兜底,永不让市场空掉。

## 方案选型

- **方案 A(采纳)**:一个合并端点 `GET /api/community-catalog` 返回 `{mcp, prompts, skills, assistants}` 四段;客户端一个缓存文件 + 一次后台 sync;只改现有两个读取器。链路最短、发布口子唯一。
- 方案 B(否):塞进现有 `/api/catalog`。省一个端点但语义混杂、与 provider 同步耦合。
- 方案 C(否):拆两个端点各对应一个客户端读取器。多一套管道,收益不大。

## 架构

### ① 服务端数据源(照搬 app_catalog 模式)

- 新 `server/static/defaults/community-catalog.yaml` —— 种子数据 = 现有 mcp-catalog.yaml + resource-catalog.js 的 `BUILTIN_CATALOG`,四段结构(`mcp` / `prompts` / `skills` / `assistants`),带 `version`。
- 新 `server/community_catalog.py`:
  - `CONFIG_KEY = "config.community_catalog"`
  - `load_community_catalog_doc()` —— yaml 默认 ← DB config 覆盖
  - `community_catalog_payload()` —— 返回 `{ version, mcp, prompts, skills, assistants }`
  - `publish_community_catalog(doc | None)` —— 写 DB config(照搬 [routing_catalog.py](../../../server/routing_catalog.py) 的 publish)
- `server.py` 加公开路由 `GET /api/community-catalog`(公开,与 `/api/catalog` 一致,推荐项非敏感)。
- `admin_router.py` 加:
  - `POST /admin/community-catalog/publish`(`Depends(auth_admin)`)
  - `POST /admin/community-catalog/import-defaults`(从 yaml 重新种子到 DB)
  - 照搬 [routing_catalog_router.py](../../../server/routing_catalog_router.py) 结构。

### ② 客户端下发/缓存

- [catalog-sync.js](../../../client/electron/catalog-sync.js) 的 `scheduleBackgroundSync` 顺带 `GET /api/community-catalog`,落缓存 `~/.tokenbank/community-catalog.yaml`。
- 拉取失败静默(仅 `console.warn`),不阻断 provider 同步、不清空既有缓存。

### ③ 两个读取器改造(对外 API 签名不变)

- [mcp-catalog.js](../../../client/electron/mcp-catalog.js):
  - `CATALOG_CANDIDATES` 最高优先级加**用户缓存** `~/.tokenbank/community-catalog.yaml` 的 `mcp` 段。
  - 合并语义:缓存 MCP 项覆盖同 `catalogId`;**永远保留** `tokenbank-agent-bridge` / `tokenbank-prompts`(`alwaysInstalled`,不被下发列表冲掉)。
  - 本地 `config/mcp-catalog.yaml` 降为离线兜底(最低优先级)。
- [resource-catalog.js](../../../client/electron/resource-catalog.js):
  - 从缓存 yaml 的 `prompts` / `skills` / `assistants` 段读取,硬编码 `BUILTIN_CATALOG` 降为离线兜底。
  - `getCatalogItem` / `listCatalogItems` / `listCatalogGrouped` 签名与返回结构不变;`resource-manager.installFromCatalog` 零改动。

### ④ 兜底与合并原则

无服务器 / 拉取失败 → 上次缓存 yaml → 再不行用内置默认。合并语义与 provider 一致:server 项覆盖同 `catalogId` / `name`,内置做 fallback,Token Bank 内置 MCP 永不被冲掉。

## 数据流

```
运营改 yaml 或调 publish
      → DB config.community_catalog（或 yaml 默认）
      → GET /api/community-catalog  { version, mcp, prompts, skills, assistants }
      → catalog-sync 后台拉取 → ~/.tokenbank/community-catalog.yaml
      → mcp-catalog.js / resource-catalog.js 读缓存（内置兜底）
      → MCP 市场 / Resources 目录 UI 展示推荐
      → 用户点 install → 纳管 → 手动投射到 agent（既有流程，不变）
```

## 关键文件

| 路径 | 改动 |
|---|---|
| `server/static/defaults/community-catalog.yaml` | 新增,四段种子数据 |
| `server/community_catalog.py` | 新增,load / payload / publish |
| `server/server.py` | 加 `GET /api/community-catalog` |
| `server/admin_router.py` | 加 publish / import-defaults 路由 |
| `client/electron/catalog-sync.js` | 后台 sync 顺带拉取 + 落缓存 |
| `client/electron/mcp-catalog.js` | 缓存最高优先 + 保留内置 MCP |
| `client/electron/resource-catalog.js` | 缓存优先 + BUILTIN 兜底 |

## 测试(Electron-as-node 下)

- 服务端:`community_catalog_payload` 合并 yaml + DB;`publish` 写 DB;`GET /api/community-catalog` 公开可达。
- 客户端:
  - `mcp-catalog` 优先缓存、覆盖同 id、且始终包含 `tokenbank-agent-bridge` / `tokenbank-prompts`。
  - `resource-catalog` 优先缓存、缓存缺失时回退 `BUILTIN_CATALOG`。
  - `catalog-sync` 拉取成功写缓存、失败不清空缓存。

## 风险与边界

- **内置 MCP 被冲掉**:合并时强制并入 `alwaysInstalled` 内置项,加断言测试守护。
- **离线首启无缓存**:两个读取器必须在无缓存时回退内置默认,保证市场非空。
- **yaml 结构漂移**:server 种子 yaml 与客户端读取器共用四段 schema,字段变更需同步两端(种子数据从现有内置直接迁移,首版天然对齐)。
