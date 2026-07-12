# 社区推荐资源服务器下发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MCP / Skill / Prompt / Agent 四类「社区推荐」目录从客户端内置静态数据改为服务器下发,运营改推荐列表无需发新版客户端。

**Architecture:** 照搬已存在的 provider catalog 下发链路——服务端 `GET /api/community-catalog` 从 yaml 默认(DB 覆盖)组装四段 payload;客户端后台 sync 落缓存 `~/.tokenbank/community-catalog.yaml`;`mcp-catalog.js` / `resource-catalog.js` 优先读缓存、内置做离线兜底。只更新「可选推荐列表」,安装与投射仍由用户手动触发。

**Tech Stack:** 服务端 Python(FastAPI + `database.get_config/set_config` + PyYAML,`unittest`);客户端 Node/Electron(`node:test`,`ELECTRON_RUN_AS_NODE=1`,`js-yaml`)。

## Global Constraints

- 服务端默认 MCP 数据**复用**现有客户端文件 `client/electron/config/mcp-catalog.yaml`(不复制那 601 行),仿照 `routing_catalog.py` 读 `_STRATEGIES_CLIENT` 的做法。
- Token Bank 内置 MCP(`tokenbank-agent-bridge` / `tokenbank-prompts`,`always_installed: true`)**永远保留**,不得被下发列表冲掉。
- 两个客户端读取器对外 API 签名**不变**:`getCatalogItem` / `listCatalogItems` / `listCatalogGrouped`;`resource-manager.installFromCatalog` 零改动。
- 缓存拉取失败**静默**(`console.warn`),不阻断 provider 同步、不清空既有缓存。
- 客户端缓存路径:`path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml')`(与 `client/shared/telemetry.js` 的 `STATS_DIR` 同目录)。
- 公开端点 `GET /api/community-catalog`(无鉴权,与 `/api/catalog` 一致);admin 路由 `Depends(auth_admin)`,`prefix="/admin"`。
- 服务端纯函数(不碰 DB)单独可 `unittest` 测;异步/IO 层薄封装。

---

## File Structure

| 路径 | 职责 | 新建/修改 |
|---|---|---|
| `server/static/defaults/community-resources.yaml` | prompts/skills/assistants 默认种子(从 `resource-catalog.js` 的 `BUILTIN_CATALOG` 迁移) | 新建 |
| `server/community_catalog.py` | 加载默认(client mcp yaml + resources yaml)→ DB 覆盖 → 归一化 → payload;publish/import | 新建 |
| `server/community_catalog_router.py` | admin publish / import-defaults 路由 | 新建 |
| `server/server.py:189` | 加 `GET /api/community-catalog` 公开路由 | 修改 |
| `server/server.py:158` 附近 | 注册 `community_catalog_router` | 修改 |
| `server/test_community_catalog.py` | 服务端纯函数单测 | 新建 |
| `client/electron/mcp-catalog.js` | 缓存最高优先 + 强制并入内置 MCP | 修改 |
| `client/electron/resource-catalog.js` | 缓存优先 + `BUILTIN_CATALOG` 兜底 | 修改 |
| `client/electron/catalog-sync.js` | 拉 `/api/community-catalog` + 写缓存 | 修改 |
| `client/electron/__tests__/community-catalog-sync.test.js` | 客户端单测 | 新建 |

---

## Task 1: 服务端默认加载 + 归一化(纯函数)

**Files:**
- Create: `server/static/defaults/community-resources.yaml`
- Create: `server/community_catalog.py`
- Test: `server/test_community_catalog.py`

**Interfaces:**
- Produces:
  - `load_default_doc() -> dict` — `{ "version": 1, "mcp": [...], "prompts": [...], "skills": [...], "assistants": [...] }`,`mcp` 来自 client `mcp-catalog.yaml` 的 `items`,其余来自 `community-resources.yaml`。
  - `normalize_catalog_doc(doc: dict) -> dict` — 保证四段都存在为 list,`version` 为 int。
  - `catalog_payload_from_doc(doc: dict) -> dict` — 归一化后的对外 payload(结构同 `load_default_doc`)。
  - `MCP_CATALOG_CLIENT: Path` / `RESOURCES_DEFAULT: Path` 常量。

- [ ] **Step 1: 迁移 prompts/skills/assistants 种子到 yaml**

把 `client/electron/resource-catalog.js` 的 `BUILTIN_CATALOG` 数组逐条迁移进新文件,按 `type` 分到三段。schema 与源字段一一对应(`catalogId`→`catalog_id`,`display_name`/`description`/`metadata`/`content` 原样;assistant 的 `content` 是 JSON 字符串,原样作为 yaml 多行字符串)。完整示例(必须包含 `BUILTIN_CATALOG` 里全部 5 条:`code-review-prompt`、`api-design-prompt`、`git-commit-skill`、`systematic-debugging-skill`、`python-expert-assistant`):

Create `server/static/defaults/community-resources.yaml`:
```yaml
version: 1
prompts:
- catalog_id: code-review-prompt
  type: prompt
  name: code-review
  display_name: 代码审查
  description: 结构化代码审查：安全、性能、可维护性
  metadata:
    tags: [code, review, quality]
    version: 1.0.0
  content: |
    你是一个资深代码审查专家。请审查以下代码，输出：
    1. 严重问题（必须修复）
    2. 改进建议（可选）
    3. 简要总结

    {{#if focus_security}}重点关注安全漏洞与权限问题。{{/if}}
    {{#if focus_performance}}重点关注性能与资源占用。{{/if}}

    代码：
    ```
    {{code}}
    ```
- catalog_id: api-design-prompt
  type: prompt
  name: api-design
  display_name: API 设计
  description: REST/OpenAPI 接口设计与评审
  metadata:
    tags: [api, design, backend]
    version: 1.0.0
  content: |
    你是 API 架构师。根据需求设计 REST API：
    - 资源命名与 HTTP 动词
    - 请求/响应 JSON Schema 要点
    - 错误码与分页约定
    - 鉴权方式建议

    需求描述：
    {{requirements}}
skills:
- catalog_id: git-commit-skill
  type: skill
  name: git-commit
  display_name: Git 提交规范
  description: 生成符合 Conventional Commits 的提交信息
  metadata:
    tags: [git, commit, workflow]
    version: 1.0.0
    compatible_agents: [claude-code, codex, cursor, workbuddy]
  content: |
    ---
    name: git-commit
    description: 分析 diff 并生成规范的 Git 提交信息（Conventional Commits）
    ---

    # Git Commit Skill

    ## 何时使用
    用户要求写 commit message、总结变更、或准备 git commit 时。

    ## 规则
    1. 使用 Conventional Commits：feat/fix/docs/refactor/test/chore 等
    2. 标题 ≤ 72 字符，英文或中文均可
    3. 正文说明 WHY，必要时列出 BREAKING CHANGE

    ## 输出格式
    ```
    <type>(<scope>): <subject>

    <body>
    ```
- catalog_id: systematic-debugging-skill
  type: skill
  name: systematic-debugging
  display_name: 系统化调试
  description: 遇 bug 时按步骤收集证据再修复
  metadata:
    tags: [debug, quality]
    version: 1.0.0
    compatible_agents: [claude-code, codex, cursor, workbuddy]
  content: |
    ---
    name: systematic-debugging
    description: 系统化调试流程，先复现与定位根因再改代码
    ---

    # Systematic Debugging

    ## 流程
    1. 复现：最小步骤、期望 vs 实际
    2. 证据：日志、堆栈、最近变更
    3. 假设：列出 2–3 个可能根因并验证
    4. 修复：最小 diff，附带验证方式
    5. 回归：确认未引入新问题

    ## 禁止
    - 未理解根因就大面积重写
    - 同时改多处 unrelated 代码
assistants:
- catalog_id: python-expert-assistant
  type: assistant
  name: python-expert
  display_name: Python 专家
  description: Python / 数据科学 / Web 开发预设
  metadata:
    tags: [python, assistant, development]
    version: 1.0.0
    category: development
  content: |
    {
      "soul": "你是 Python 专家，精通标准库、类型注解、pytest 与 FastAPI。回答简洁，代码可运行。",
      "skills": ["systematic-debugging"],
      "prompts": ["code-review"],
      "parameters": { "temperature": 0.3 }
    }
```

- [ ] **Step 2: 写失败测试**

Create `server/test_community_catalog.py`:
```python
# server/test_community_catalog.py
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import unittest
import community_catalog as cc


class TestDefaultDoc(unittest.TestCase):
    def test_default_doc_has_four_sections(self):
        doc = cc.load_default_doc()
        for key in ("mcp", "prompts", "skills", "assistants"):
            self.assertIsInstance(doc[key], list, f"{key} must be a list")

    def test_mcp_reuses_client_catalog_with_builtin(self):
        doc = cc.load_default_doc()
        ids = {m.get("catalog_id") or m.get("id") for m in doc["mcp"]}
        self.assertIn("tokenbank-agent-bridge", ids)
        self.assertIn("tokenbank-prompts", ids)

    def test_resources_seeded_from_yaml(self):
        doc = cc.load_default_doc()
        names = {p["name"] for p in doc["prompts"]}
        self.assertIn("code-review", names)
        self.assertEqual({s["name"] for s in doc["skills"]},
                         {"git-commit", "systematic-debugging"})
        self.assertEqual([a["name"] for a in doc["assistants"]], ["python-expert"])

    def test_normalize_fills_missing_sections(self):
        out = cc.normalize_catalog_doc({"mcp": [{"catalog_id": "x"}]})
        self.assertEqual(out["prompts"], [])
        self.assertEqual(out["skills"], [])
        self.assertEqual(out["assistants"], [])
        self.assertEqual(out["version"], 1)

    def test_payload_from_doc_roundtrip(self):
        payload = cc.catalog_payload_from_doc(cc.load_default_doc())
        self.assertIn("code-review", {p["name"] for p in payload["prompts"]})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd server && python -m unittest test_community_catalog -v`
Expected: FAIL —— `ModuleNotFoundError: No module named 'community_catalog'`

- [ ] **Step 4: 实现 `community_catalog.py`(默认加载 + 归一化)**

Create `server/community_catalog.py`:
```python
"""社区推荐目录 —— 通过 GET /api/community-catalog 下发给客户端。

四段:mcp / prompts / skills / assistants。
默认数据源:
  - mcp:       复用 client/electron/config/mcp-catalog.yaml 的 items(仿 routing_catalog 读 client 文件)
  - 其余三段:  static/defaults/community-resources.yaml
DB config.community_catalog 可整体覆盖默认。
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import database as db

CONFIG_KEY = "config.community_catalog"
_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_REPO_ROOT = Path(__file__).resolve().parent.parent
MCP_CATALOG_CLIENT = _REPO_ROOT / "client" / "electron" / "config" / "mcp-catalog.yaml"
MCP_CATALOG_SERVER = _DEFAULTS_DIR / "mcp-catalog.yaml"
RESOURCES_DEFAULT = _DEFAULTS_DIR / "community-resources.yaml"

_SECTIONS = ("mcp", "prompts", "skills", "assistants")


def _read_yaml(path: Path) -> dict:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _parse_json_or_yaml(text: str) -> dict:
    text = (text or "").strip()
    if not text:
        return {}
    try:
        parsed = yaml.safe_load(text)
        if isinstance(parsed, dict):
            return parsed
    except yaml.YAMLError:
        pass
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return {}


def load_default_doc() -> dict:
    """从 client mcp-catalog.yaml + community-resources.yaml 组装默认四段。"""
    mcp_path = MCP_CATALOG_CLIENT if MCP_CATALOG_CLIENT.is_file() else MCP_CATALOG_SERVER
    mcp_doc = _read_yaml(mcp_path)
    res_doc = _read_yaml(RESOURCES_DEFAULT)
    return normalize_catalog_doc({
        "version": res_doc.get("version") or mcp_doc.get("version") or 1,
        "mcp": mcp_doc.get("items") or [],
        "prompts": res_doc.get("prompts") or [],
        "skills": res_doc.get("skills") or [],
        "assistants": res_doc.get("assistants") or [],
    })


def normalize_catalog_doc(doc: dict) -> dict:
    doc = doc if isinstance(doc, dict) else {}
    out = {"version": int(doc.get("version") or 1)}
    for key in _SECTIONS:
        val = doc.get(key)
        out[key] = [x for x in val if isinstance(x, dict)] if isinstance(val, list) else []
    return out


def catalog_payload_from_doc(doc: dict) -> dict:
    return normalize_catalog_doc(doc)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd server && python -m unittest test_community_catalog -v`
Expected: PASS(5 tests)

- [ ] **Step 6: 提交**

```bash
git add -f server/community_catalog.py server/static/defaults/community-resources.yaml server/test_community_catalog.py
git commit -m "feat(community-catalog): 服务端默认加载 + 归一化(四段纯函数)"
```

---

## Task 2: 服务端异步层 + 公开/管理路由

**Files:**
- Modify: `server/community_catalog.py`(加 async DB 层)
- Create: `server/community_catalog_router.py`
- Modify: `server/server.py`(公开路由 + 注册 admin router)
- Test: `server/test_community_catalog.py`(加 async 用例)

**Interfaces:**
- Consumes: Task 1 的 `load_default_doc` / `normalize_catalog_doc` / `catalog_payload_from_doc` / `CONFIG_KEY`。
- Produces:
  - `async load_community_catalog_doc() -> dict` — DB `config.community_catalog` 有则用,否则 `load_default_doc()`。
  - `async save_catalog_doc(doc: dict) -> None` — 归一化后 `set_config`。
  - `async import_from_defaults() -> dict` — 把默认写进 DB,返回 `{ "ok": True, "counts": {...} }`。
  - `async community_catalog_payload() -> dict` — 对外 payload。
  - `async publish_community_catalog() -> dict` — 归一化当前 DB doc 重存,返回各段计数。
  - 路由:`GET /api/community-catalog`(公开)、`POST /admin/community-catalog/publish`、`POST /admin/community-catalog/import-defaults`。

- [ ] **Step 1: 写失败测试(async + 路由)**

在 `server/test_community_catalog.py` 追加:
```python
import asyncio
import database as db


class TestAsyncLayer(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await db.set_config(cc.CONFIG_KEY, "")

    async def test_load_doc_falls_back_to_default(self):
        doc = await cc.load_community_catalog_doc()
        self.assertIn("code-review", {p["name"] for p in doc["prompts"]})

    async def test_db_override_wins(self):
        await cc.save_catalog_doc({"version": 2, "prompts": [
            {"catalog_id": "only", "type": "prompt", "name": "only"}]})
        doc = await cc.load_community_catalog_doc()
        self.assertEqual([p["name"] for p in doc["prompts"]], ["only"])
        self.assertEqual(doc["version"], 2)

    async def test_import_from_defaults_seeds_db(self):
        res = await cc.import_from_defaults()
        self.assertTrue(res["ok"])
        doc = await cc.load_community_catalog_doc()
        self.assertIn("git-commit", {s["name"] for s in doc["skills"]})

    async def test_payload_public_shape(self):
        payload = await cc.community_catalog_payload()
        for key in ("version", "mcp", "prompts", "skills", "assistants"):
            self.assertIn(key, payload)
```

> 注:`IsolatedAsyncioTestCase` 会真实读写 DB 配置表(与 `test_auth.py` 同环境)。运行前确保 `server` 目录下 DB 可初始化;若测试环境无 DB,`db.set_config`/`get_config` 应可用 sqlite 默认库。

- [ ] **Step 2: 运行确认失败**

Run: `cd server && python -m unittest test_community_catalog.TestAsyncLayer -v`
Expected: FAIL —— `AttributeError: module 'community_catalog' has no attribute 'load_community_catalog_doc'`

- [ ] **Step 3: 实现 async 层(追加到 `community_catalog.py`)**

在 `server/community_catalog.py` 末尾追加:
```python
async def load_community_catalog_doc() -> dict:
    raw = await db.get_config(CONFIG_KEY, "")
    if raw.strip():
        doc = _parse_json_or_yaml(raw)
        if doc:
            return normalize_catalog_doc(doc)
    return load_default_doc()


async def save_catalog_doc(doc: dict) -> None:
    payload = normalize_catalog_doc(doc)
    await db.set_config(CONFIG_KEY, json.dumps(payload, ensure_ascii=False, indent=2))


async def import_from_defaults() -> dict:
    doc = load_default_doc()
    await save_catalog_doc(doc)
    return {"ok": True, "counts": {k: len(doc[k]) for k in _SECTIONS}}


async def community_catalog_payload() -> dict:
    return catalog_payload_from_doc(await load_community_catalog_doc())


async def publish_community_catalog() -> dict:
    doc = await load_community_catalog_doc()
    await save_catalog_doc(doc)
    return {"ok": True, "counts": {k: len(doc[k]) for k in _SECTIONS}}
```

- [ ] **Step 4: 创建 admin router**

Create `server/community_catalog_router.py`:
```python
"""Admin API：社区推荐目录发布 / 从默认导入。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

import community_catalog as cc
from admin_router import auth_admin

router = APIRouter()


@router.post("/community-catalog/import-defaults", dependencies=[Depends(auth_admin)])
async def import_community_defaults():
    return await cc.import_from_defaults()


@router.post("/community-catalog/publish", dependencies=[Depends(auth_admin)])
async def publish_community_catalog():
    return await cc.publish_community_catalog()
```

- [ ] **Step 5: 挂公开路由 + 注册 admin router**

在 `server/server.py` 中,`@app.get("/api/catalog")` 块之后(约 189 行)加:
```python
@app.get("/api/community-catalog")
async def public_community_catalog():
    """公开接口：社区推荐目录(mcp/prompts/skills/assistants)"""
    import community_catalog as cc
    return await cc.community_catalog_payload()
```
在 import 区(约 30 行,`routing_catalog_router` 下面)加:
```python
from community_catalog_router import router as community_catalog_router
```
在 `app.include_router(routing_catalog_router, prefix="/admin")`(约 158 行)之后加:
```python
app.include_router(community_catalog_router, prefix="/admin")
```

- [ ] **Step 6: 运行全部服务端测试确认通过**

Run: `cd server && python -m unittest test_community_catalog -v`
Expected: PASS(全部,含 TestDefaultDoc 与 TestAsyncLayer)

- [ ] **Step 7: 冒烟公开端点**

Run:
```bash
cd server && python -c "import asyncio, community_catalog as cc; \
p = asyncio.run(cc.community_catalog_payload()); \
print(sorted(p.keys()), len(p['mcp']), len(p['prompts']), len(p['skills']), len(p['assistants']))"
```
Expected: 打印 `['assistants', 'mcp', 'prompts', 'skills', 'version'] <n_mcp> 2 2 1`,且 `<n_mcp>` ≥ 2。

- [ ] **Step 8: 提交**

```bash
git add -f server/community_catalog.py server/community_catalog_router.py server/server.py server/test_community_catalog.py
git commit -m "feat(community-catalog): 公开端点 /api/community-catalog + admin publish/import-defaults"
```

---

## Task 3: 客户端 `mcp-catalog.js` 优先读缓存 + 强制保留内置 MCP

**Files:**
- Modify: `client/electron/mcp-catalog.js`
- Test: `client/electron/__tests__/community-catalog-sync.test.js`(本任务新建,含 mcp-catalog 用例)

**Interfaces:**
- Consumes: 缓存文件 `~/.tokenbank/community-catalog.yaml` 的 `mcp:` 段(结构同 `mcp-catalog.yaml` 的 `items`)。
- Produces: `mcp-catalog.js` 的 `listCatalogItems()` 结果 = 缓存 mcp 项覆盖同 `catalogId`,且始终并入内置 `alwaysInstalled` 项;`resetCatalogCache()` 已存在,用于测试清缓存。

- [ ] **Step 1: 写失败测试**

Create `client/electron/__tests__/community-catalog-sync.test.js`:
```javascript
'use strict';
// 社区推荐目录:缓存优先 + 内置 MCP 永不丢失
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const CACHE = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');

function writeCache(doc) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, yaml.dump(doc), 'utf8');
}
function clearCache() {
  try { fs.unlinkSync(CACHE); } catch {}
}

test('mcp-catalog: 缓存项覆盖同 id 且保留内置 MCP', () => {
  const mcpCatalog = require('../mcp-catalog');
  writeCache({
    version: 1,
    mcp: [{
      catalog_id: 'community-demo', id: 'community-demo', name: 'community-demo',
      display_name: 'Community Demo', type: 'stdio', command: 'npx', args: ['-y', 'demo'],
      metadata: { categoryGroup: 'official' }, config_fields: [],
    }],
    prompts: [], skills: [], assistants: [],
  });
  mcpCatalog.resetCatalogCache();
  const ids = new Set(mcpCatalog.listCatalogItems().map(i => i.catalogId));
  assert.ok(ids.has('community-demo'), '缓存项应出现');
  assert.ok(ids.has('tokenbank-agent-bridge'), '内置 bridge 永不丢');
  assert.ok(ids.has('tokenbank-prompts'), '内置 prompts 永不丢');
  clearCache();
  mcpCatalog.resetCatalogCache();
});

test('mcp-catalog: 无缓存时回退本地内置 yaml', () => {
  const mcpCatalog = require('../mcp-catalog');
  clearCache();
  mcpCatalog.resetCatalogCache();
  const ids = new Set(mcpCatalog.listCatalogItems().map(i => i.catalogId));
  assert.ok(ids.has('tokenbank-agent-bridge'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 electron --test electron/__tests__/community-catalog-sync.test.js`
Expected: FAIL —— 缓存项 `community-demo` 未出现(当前只读本地 yaml)。

- [ ] **Step 3: 实现缓存优先合并**

在 `client/electron/mcp-catalog.js` 顶部(`CATALOG_CANDIDATES` 定义处,约 27 行)之上加缓存路径常量:
```javascript
const USER_CACHE = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');
```
修改 `loadCatalogMeta()`(约 134 行),在读本地 yaml 得到 `_cachedCatalog` 之后、返回之前,叠加用户缓存的 `mcp` 段并强制并入内置项。将函数体改为:
```javascript
function loadCatalogMeta() {
  if (_cachedCatalog) {
    return {
      items: _cachedCatalog,
      categoryGroups: _cachedCategoryGroups || MCP_CATEGORY_GROUPS,
      groupOrder: _cachedGroupOrder || GROUP_ORDER,
    };
  }

  const doc = readCatalogDoc();
  const baseItems = doc && Array.isArray(doc.items)
    ? doc.items.map(normalizeYamlItem).filter(Boolean)
    : fallbackCatalog();
  _cachedCategoryGroups = doc
    ? { ...MCP_CATEGORY_GROUPS, ...(doc.category_groups || doc.categoryGroups || {}) }
    : MCP_CATEGORY_GROUPS;
  _cachedGroupOrder = Array.isArray(doc?.group_order || doc?.groupOrder)
    ? (doc.group_order || doc.groupOrder)
    : GROUP_ORDER;

  _cachedCatalog = mergeCommunityMcp(baseItems);
  return {
    items: _cachedCatalog,
    categoryGroups: _cachedCategoryGroups,
    groupOrder: _cachedGroupOrder,
  };
}

/** 用户缓存 mcp 段覆盖同 catalogId,并强制并入内置 always_installed 项 */
function mergeCommunityMcp(baseItems) {
  const byId = new Map();
  for (const it of baseItems) byId.set(it.catalogId, it);

  let cachedItems = [];
  try {
    if (fs.existsSync(USER_CACHE)) {
      const cached = yaml.load(fs.readFileSync(USER_CACHE, 'utf8'));
      if (cached && Array.isArray(cached.mcp)) {
        cachedItems = cached.mcp.map(normalizeYamlItem).filter(Boolean);
      }
    }
  } catch (e) {
    console.warn('[mcp-catalog] read community cache failed:', e.message);
  }
  for (const it of cachedItems) byId.set(it.catalogId, it);

  // 内置 always_installed 项永不被下发列表冲掉
  for (const it of fallbackCatalog()) {
    if (it.alwaysInstalled) byId.set(it.catalogId, it);
  }
  return [...byId.values()];
}
```
> 说明:原 `loadCatalogMeta` 无缓存时把 `_cachedCatalog = fallbackCatalog()`;新逻辑统一走 `mergeCommunityMcp`,`baseItems` 无 doc 时即 `fallbackCatalog()`,内置项经 `alwaysInstalled` 循环仍保证在内。

- [ ] **Step 4: 运行确认通过**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 electron --test electron/__tests__/community-catalog-sync.test.js`
Expected: PASS(2 tests)

- [ ] **Step 5: 回归 mcp 相关既有测试**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 electron --test electron/__tests__/mcp-sync-discovered.test.js electron/__tests__/prompt-mcp-sync.test.js`
Expected: PASS(未回归)

- [ ] **Step 6: 提交**

```bash
git add client/electron/mcp-catalog.js client/electron/__tests__/community-catalog-sync.test.js
git commit -m "feat(mcp-catalog): 优先读社区缓存,内置 MCP 强制保留"
```

---

## Task 4: 客户端 `resource-catalog.js` 缓存优先 + BUILTIN 兜底

**Files:**
- Modify: `client/electron/resource-catalog.js`
- Test: `client/electron/__tests__/community-catalog-sync.test.js`(追加用例)

**Interfaces:**
- Consumes: 缓存文件 `~/.tokenbank/community-catalog.yaml` 的 `prompts` / `skills` / `assistants` 段。
- Produces: `listCatalogItems` / `getCatalogItem` / `listCatalogGrouped` 优先返回缓存项,缓存缺失时回退 `BUILTIN_CATALOG`;新增 `resetCatalogCache()`。签名与返回结构不变。

- [ ] **Step 1: 追加失败测试**

在 `client/electron/__tests__/community-catalog-sync.test.js` 追加:
```javascript
test('resource-catalog: 缓存优先返回下发项', () => {
  const resCatalog = require('../resource-catalog');
  writeCache({
    version: 1, mcp: [],
    prompts: [{ catalogId: 'srv-prompt', type: 'prompt', name: 'srv-prompt',
      display_name: '服务端提示词', description: 'from server', content: 'X' }],
    skills: [], assistants: [],
  });
  resCatalog.resetCatalogCache();
  const names = resCatalog.listCatalogItems().map(i => i.name);
  assert.ok(names.includes('srv-prompt'), '应含下发 prompt');
  assert.ok(!names.includes('code-review'), '缓存存在时不混入 BUILTIN');
  assert.equal(resCatalog.getCatalogItem('srv-prompt').display_name, '服务端提示词');
  clearCache();
  resCatalog.resetCatalogCache();
});

test('resource-catalog: 无缓存回退 BUILTIN', () => {
  const resCatalog = require('../resource-catalog');
  clearCache();
  resCatalog.resetCatalogCache();
  const names = resCatalog.listCatalogItems().map(i => i.name);
  assert.ok(names.includes('code-review'), '无缓存时用内置');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 electron --test electron/__tests__/community-catalog-sync.test.js`
Expected: FAIL —— `resCatalog.resetCatalogCache is not a function` / 缓存项未生效。

- [ ] **Step 3: 实现缓存读取层**

改 `client/electron/resource-catalog.js`。顶部 `'use strict';` 后加依赖与缓存:
```javascript
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const USER_CACHE = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');
let _cached = null;
```
在 `BUILTIN_CATALOG` 定义之后、`getCatalogItem` 之前插入:
```javascript
/** 缓存优先:读 ~/.tokenbank/community-catalog.yaml 的三段;无缓存回退 BUILTIN */
function activeCatalog() {
  if (_cached) return _cached;
  try {
    if (fs.existsSync(USER_CACHE)) {
      const doc = yaml.load(fs.readFileSync(USER_CACHE, 'utf8'));
      const merged = []
        .concat(Array.isArray(doc?.prompts) ? doc.prompts : [])
        .concat(Array.isArray(doc?.skills) ? doc.skills : [])
        .concat(Array.isArray(doc?.assistants) ? doc.assistants : [])
        .map(normalizeCacheItem)
        .filter(Boolean);
      if (merged.length) {
        _cached = merged;
        return _cached;
      }
    }
  } catch (e) {
    console.warn('[resource-catalog] read community cache failed:', e.message);
  }
  _cached = BUILTIN_CATALOG;
  return _cached;
}

/** yaml snake_case → 运行时字段(与 BUILTIN 条目结构对齐) */
function normalizeCacheItem(raw) {
  if (!raw || !(raw.catalog_id || raw.catalogId)) return null;
  return {
    catalogId: raw.catalog_id || raw.catalogId,
    type: raw.type,
    name: raw.name,
    display_name: raw.display_name || raw.displayName || raw.name,
    description: raw.description || '',
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    content: raw.content || '',
  };
}

function resetCatalogCache() {
  _cached = null;
}
```
把三个查询函数改为读 `activeCatalog()` 而非直接 `BUILTIN_CATALOG`:
```javascript
function getCatalogItem(catalogId) {
  return activeCatalog().find(c => c.catalogId === catalogId) || null;
}

function listCatalogItems(filters = {}) {
  let items = activeCatalog().filter(i => i.type !== 'template');
  if (filters.type) items = items.filter(i => i.type === filters.type);
  if (filters.query) {
    const q = String(filters.query).toLowerCase();
    items = items.filter(i =>
      i.name.includes(q)
      || (i.display_name || '').toLowerCase().includes(q)
      || (i.description || '').toLowerCase().includes(q)
      || (i.metadata?.tags || []).some(t => t.includes(q)),
    );
  }
  return items;
}

function listCatalogGrouped() {
  const groups = {};
  for (const item of activeCatalog()) {
    if (!groups[item.type]) groups[item.type] = [];
    groups[item.type].push(item);
  }
  return groups;
}
```
在 `module.exports` 里加 `resetCatalogCache`:
```javascript
module.exports = {
  RESOURCE_TYPE_LABELS,
  BUILTIN_CATALOG,
  getCatalogItem,
  listCatalogItems,
  listCatalogGrouped,
  resetCatalogCache,
};
```

- [ ] **Step 4: 运行确认通过**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 electron --test electron/__tests__/community-catalog-sync.test.js`
Expected: PASS(全部 4 tests)

- [ ] **Step 5: 提交**

```bash
git add client/electron/resource-catalog.js client/electron/__tests__/community-catalog-sync.test.js
git commit -m "feat(resource-catalog): 缓存优先 + BUILTIN 离线兜底"
```

---

## Task 5: 客户端 `catalog-sync.js` 拉取社区目录 + 写缓存

**Files:**
- Modify: `client/electron/catalog-sync.js`
- Test: `client/electron/__tests__/community-catalog-sync.test.js`(追加用例)

**Interfaces:**
- Consumes: Task 2 的公开端点 `GET /api/community-catalog`。
- Produces:
  - `fetchCommunityCatalog(baseUrl) -> Promise<object|null>` — GET 公开端点,失败/超时返回 `null`。
  - `writeCommunityCatalogCache(payload) -> boolean` — payload 含 ≥1 段非空时写 `~/.tokenbank/community-catalog.yaml`,否则不动缓存;返回是否写入。
  - `scheduleBackgroundSync` 在 provider 同步后顺带调这两者(失败静默)。

- [ ] **Step 1: 追加失败测试(纯函数 writeCommunityCatalogCache)**

在 `community-catalog-sync.test.js` 追加:
```javascript
test('writeCommunityCatalogCache: 有内容才写,空 payload 不动缓存', () => {
  const catalogSync = require('../catalog-sync');
  clearCache();
  const wrote = catalogSync.writeCommunityCatalogCache({
    version: 1, mcp: [], prompts: [{ catalog_id: 'p', type: 'prompt', name: 'p' }],
    skills: [], assistants: [],
  });
  assert.equal(wrote, true);
  assert.ok(fs.existsSync(CACHE));
  const back = yaml.load(fs.readFileSync(CACHE, 'utf8'));
  assert.equal(back.prompts[0].name, 'p');

  clearCache();
  const wrote2 = catalogSync.writeCommunityCatalogCache({ mcp: [], prompts: [], skills: [], assistants: [] });
  assert.equal(wrote2, false);
  assert.ok(!fs.existsSync(CACHE), '空 payload 不落缓存');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 electron --test electron/__tests__/community-catalog-sync.test.js`
Expected: FAIL —— `catalogSync.writeCommunityCatalogCache is not a function`。

- [ ] **Step 3: 实现拉取 + 写缓存**

在 `client/electron/catalog-sync.js` 顶部常量区(`USER_REGISTRY_YAML` 附近,约 14 行)加:
```javascript
const USER_COMMUNITY_CATALOG = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');
const COMMUNITY_SECTIONS = ['mcp', 'prompts', 'skills', 'assistants'];
```
在 `fetchCatalogJson` 函数之后加:
```javascript
/** GET /api/community-catalog → JSON(公开,失败返回 null) */
function fetchCommunityCatalog(baseUrl) {
  const base = normalizeBase(baseUrl);
  if (!base) return Promise.resolve(null);
  const url = `${base}/api/community-catalog`;
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** payload 至少一段非空才写缓存;写成功返回 true */
function writeCommunityCatalogCache(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const hasContent = COMMUNITY_SECTIONS.some(k => Array.isArray(payload[k]) && payload[k].length);
  if (!hasContent) return false;
  const doc = {
    version: payload.version || 1,
    mcp: Array.isArray(payload.mcp) ? payload.mcp : [],
    prompts: Array.isArray(payload.prompts) ? payload.prompts : [],
    skills: Array.isArray(payload.skills) ? payload.skills : [],
    assistants: Array.isArray(payload.assistants) ? payload.assistants : [],
  };
  const dir = path.dirname(USER_COMMUNITY_CATALOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USER_COMMUNITY_CATALOG, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
  return true;
}

/** 后台拉社区目录并落缓存(失败静默) */
async function syncCommunityCatalog(opts = {}) {
  const baseUrl = resolveSyncServerUrl(opts);
  if (!baseUrl) return { ok: false };
  const payload = await fetchCommunityCatalog(baseUrl);
  const wrote = writeCommunityCatalogCache(payload);
  if (wrote) {
    try { require('./mcp-catalog').resetCatalogCache(); } catch {}
    try { require('./resource-catalog').resetCatalogCache(); } catch {}
  }
  return { ok: !!payload, wrote };
}
```
把 `scheduleBackgroundSync`(约 387 行)改为在 provider 同步之后顺带社区同步:
```javascript
function scheduleBackgroundSync(opts = {}) {
  if (_syncInFlight) return _syncInFlight;
  _syncInFlight = syncCatalogToRegistry(opts)
    .then(async (res) => {
      try { await syncCommunityCatalog(opts); }
      catch (e) { console.warn('[catalog-sync] community sync failed:', e?.message || e); }
      return res;
    })
    .catch(err => {
      console.warn('[catalog-sync] background sync failed:', err?.message || err);
      return { ok: false, error: String(err?.message || err) };
    })
    .finally(() => { _syncInFlight = null; });
  return _syncInFlight;
}
```
在 `module.exports`(约 403 行)加导出:
```javascript
  fetchCommunityCatalog,
  writeCommunityCatalogCache,
  syncCommunityCatalog,
```

- [ ] **Step 4: 运行确认通过**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 electron --test electron/__tests__/community-catalog-sync.test.js`
Expected: PASS(全部 5 tests)

- [ ] **Step 5: 全客户端测试回归**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 electron --test electron/__tests__/*.test.js`
Expected: PASS(无回归)

- [ ] **Step 6: 提交**

```bash
git add client/electron/catalog-sync.js client/electron/__tests__/community-catalog-sync.test.js
git commit -m "feat(catalog-sync): 后台拉 /api/community-catalog 并落缓存,刷新目录读取器"
```

---

## Self-Review

**Spec coverage:**
- ① 服务端数据源(yaml 默认 + DB 覆盖 + publish)→ Task 1(默认/归一化)+ Task 2(async DB 层 + 公开端点 + admin publish/import)。✅
- ② 客户端下发/缓存(scheduleBackgroundSync 顺带拉取,失败静默不阻断)→ Task 5。✅
- ③ 两个读取器改造(签名不变)→ Task 3(mcp-catalog)+ Task 4(resource-catalog)。✅
- ④ 兜底与合并(server 覆盖同 id、内置兜底、内置 MCP 永不冲掉)→ Task 3 `mergeCommunityMcp` + Task 4 `activeCatalog` 回退 BUILTIN,测试守护。✅
- ⑤ 测试(Electron-as-node / unittest)→ 每任务均含。✅

**Placeholder scan:** 无 TBD/TODO;所有代码步含完整代码;种子数据给出全部 5 条的完整 yaml。✅

**Type consistency:**
- 缓存四段键名 `mcp/prompts/skills/assistants` 在 Task 2 payload、Task 3/4 读取、Task 5 写入一致。✅
- `catalog_id`(yaml)↔ `catalogId`(运行时)转换在 Task 3 `normalizeYamlItem`(既有)与 Task 4 `normalizeCacheItem`(新)各自处理。✅
- `resetCatalogCache()` 在 mcp-catalog(既有导出)与 resource-catalog(Task 4 新增)均存在,Task 5 两处调用均已定义。✅
- 缓存路径 `~/.tokenbank/community-catalog.yaml` 四处(Task 3/4/5 + 测试)字面一致。✅
