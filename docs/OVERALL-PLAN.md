# Token Bank 整体方案

> 吸收 AionUi、MCPMate、aweskill 的设计精华，打造模块化的 AI Agent 管理平台

**版本**：v1.0  
**日期**：2026-07-05

---

## 📋 目录

1. [核心理念](#核心理念)
2. [架构设计](#架构设计)
3. [三大核心系统](#三大核心系统)
4. [使用模式](#使用模式)
5. [技术实现](#技术实现)
6. [实施计划](#实施计划)
7. [相关文档](#相关文档)

---

## 🎯 核心理念

### 设计原则

**1. 模块化设计**

Token Bank 不是"全有或全无"的系统，而是可按需组合的模块：

- 📦 **网关代理**（可选）：代理模型请求，成本追踪
- 📦 **资源管理**（独立）：MCP/Skill/Prompt 统一管理
- 📦 **Agent 聚合**（可选）：统一入口调用多个 Agent

**2. 非侵入性**

- ✅ 不强制改变用户习惯
- ✅ Agent 聚合只是可选入口
- ✅ 可直连官方 API，只用资源管理

**3. 吸收亮点**

```
外部项目          Token Bank 吸收
─────────────────────────────────
AionUi          → Agent 聚合系统
MCPMate         → MCP 供给源管理
aweskill        → 资源管理系统
aweswitch       → (暂不实施)
```

---

## 🏗️ 架构设计

### 三层架构

```
┌─────────────────────────────────────────────────────┐
│  资源层（给 Agent 用的公共资源）                      │
│  ┌───────────────────────────────────────────────┐ │
│  │ Prompt │ Skill │ Assistant │ Template         │ │
│  │ (aweskill 启发)                               │ │
│  └─────────────────┬─────────────────────────────┘ │
│                    ↓ 提供资源                       │
├─────────────────────────────────────────────────────┤
│  执行层（Agent 聚合 - 可选入口）                      │
│  ┌───────────────────────────────────────────────┐ │
│  │ 方式 1：直接使用 Agent（原有习惯）✅           │ │
│  │   Claude Desktop / Codex / Cursor             │ │
│  │                                               │ │
│  │ 方式 2：Debug 页面统一入口（可选增值）✅       │ │
│  │   Token Bank → Agent 选择器                   │ │
│  │   (AionUi 启发)                               │ │
│  └─────────────────┬─────────────────────────────┘ │
│                    ↓ 调用供给                       │
├─────────────────────────────────────────────────────┤
│  供给层（双维度）                                    │
│  ┌──────────────────┬────────────────────────────┐ │
│  │ Model Provider   │ MCP Server                 │ │
│  │ (推理能力)       │ (工具和上下文)              │ │
│  │                  │ (MCPMate 启发)              │ │
│  │ Anthropic        │ Filesystem MCP             │ │
│  │ OpenAI           │ GitHub MCP                 │ │
│  │ Google           │ Database MCP               │ │
│  │ P2P              │ ...                        │ │
│  └──────────────────┴────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
        ↓
   local_stats
   (统一成本追踪)
```

### 数据流

```
用户操作
  ↓
┌─ 资源加载
│   - 选择 Assistant
│   - 加载关联的 Skill 和 Prompt
│   - 获取 MCP 工具列表
│
├─ Agent 执行（两种方式）
│   方式 1: 在 Agent 端直接操作
│   方式 2: 通过 Debug 页面统一调用
│
├─ 供给调用
│   - Model Provider：推理
│   - MCP Server：工具调用
│
└─ 成本记录
    - local_stats（统一追踪）
    - 可视化展示
```

---

## 🚀 三大核心系统

### 1️⃣ Agent 聚合系统（吸收 AionUi）

**定位**：**可选的**统一 Agent 操作台

**核心功能**：
- 📋 从 Gateway 读取已纳管的 Agent
- 🎮 统一界面调用多个 Agent
- 📊 实时执行日志和步骤追踪
- 💰 成本可视化展示
- 📁 文件修改记录

**关键实现**：

```javascript
// client/electron/agent-executor.js
export class AgentExecutor {
  async execute(agentId, prompt, options) {
    // 1. 加载资源
    const assistant = await this.loadAssistant(options.assistantId);
    const skills = await this.loadSkills(assistant.skills);
    const mcpTools = await this.getMCPTools(agentId);
    
    // 2. 执行 Agent
    const result = await this.callAgent(agentId, {
      prompt,
      systemPrompt: assistant.system_prompt,
      skills,
      tools: mcpTools
    });
    
    // 3. 记录成本
    await this.recordCost(agentId, result);
    
    return result;
  }
}
```

**UI 入口**：Debug 页面

```
┌─────────────────────────────────────┐
│  Agent 操作台                        │
├─────────────────────────────────────┤
│  选择 Agent:                         │
│  🤖 Claude Code                      │
│  🤖 Codex                            │
│  🤖 Cursor                           │
│                                     │
│  选择 Assistant: Python 专家         │
│  已加载技能: python-data-science    │
│  可用工具: 15 个 MCP 工具            │
│                                     │
│  [输入任务...]                       │
│  [▶ 执行]                           │
├─────────────────────────────────────┤
│  执行过程:                           │
│  🤔 Thinking...                     │
│  🔧 Tool: read_file                 │
│  ✏️  Edit: src/app.py               │
│  ✅ Completed                       │
├─────────────────────────────────────┤
│  执行结果:                           │
│  修改文件: 3 个                      │
│  耗时: 12s                          │
│  Token: 3245 (输入) + 1892 (输出)   │
│  成本: $0.0234                      │
└─────────────────────────────────────┘
```

**优先级**：**P0（最高）**

---

### 2️⃣ MCP 供给源（吸收 MCPMate）

**定位**：供给源的第二个维度（Model + MCP）

**核心功能**：
- 🗂️ 管理 MCP Server（stdio/HTTP）
- 📋 Profile 裁剪（场景化工具过滤）
- 🔗 客户端绑定管理
- 📊 日志监控和成本追踪
- 🔄 配置生成（标准格式/MCPMate 格式）

**与 MCPMate 的关系**：

```
Token Bank（管理层）
  ├─ Providers UI：统一管理 Model + MCP
  ├─ 数据管理：SQLite 存储配置
  ├─ 配置生成：导出标准配置
  └─ 成本追踪：关联 local_stats

MCPMate（代理层 - 可选）
  ├─ Bridge：stdio ↔ HTTP 转换
  ├─ Proxy：聚合多个 MCP
  └─ 高性能转发

关系：互补而非竞争
```

**数据模型**：

```sql
-- MCP 服务器
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'stdio' | 'http'
  command TEXT,              -- stdio 命令
  url TEXT,                  -- http 地址
  status TEXT,               -- 'active' | 'inactive'
  capabilities TEXT          -- JSON: 工具列表
);

-- MCP Profile
CREATE TABLE mcp_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rules TEXT NOT NULL        -- JSON: include/exclude 规则
);

-- 客户端绑定
CREATE TABLE mcp_client_bindings (
  client_id TEXT NOT NULL,   -- 'claude-desktop' | 'codex'
  server_id TEXT NOT NULL,
  profile_id TEXT
);
```

**UI 入口**：Providers 页面 → MCP Server 标签

```
┌─────────────────────────────────────┐
│  供给源管理                          │
├─────────────────────────────────────┤
│  [Model Provider] [MCP Server]      │
├─────────────────────────────────────┤
│  MCP 服务器 (5)    [➕ 添加]        │
│  ┌───────────────────────────────┐ │
│  │ 🔧 Filesystem MCP   ✅ 运行中  │ │
│  │    工具: read_file, write_file│ │
│  │    绑定: claude-desktop, codex│ │
│  │    [停止] [配置] [日志]       │ │
│  ├───────────────────────────────┤ │
│  │ 🐙 GitHub MCP       ✅ 运行中  │ │
│  │    工具: search_repos, ...    │ │
│  │    绑定: claude-desktop       │ │
│  └───────────────────────────────┘ │
│                                     │
│  MCP Profile (3)    [➕ 新建]      │
│  ┌───────────────────────────────┐ │
│  │ 📋 Development Mode           │ │
│  │    include: [filesystem.*, ...│ │
│  │    应用: claude-desktop       │ │
│  └───────────────────────────────┘ │
└─────────────────────────────────────┘
```

**优先级**：**P1（重要）**

---

### 3️⃣ 资源管理系统（吸收 aweskill）

**定位**：给 Agent 使用的公共资源

**核心功能**：
- 📝 统一管理 Prompt/Skill/Assistant/Template
- 🔗 投射机制：资源 → Agent（symlink/copy）
- 🔍 资源发现：本地/GitHub/sciskillhub
- 🔄 版本管理和更新

**资源类型**：

**1. Prompt（提示词模板）**

```javascript
{
  type: 'prompt',
  name: 'code-review',
  content: '你是代码审查专家...\n{{code}}',
  metadata: { variables: ['code'], tags: ['code', 'review'] }
}
```

**2. Skill（技能包）**

```javascript
{
  type: 'skill',
  name: 'python-data-science',
  content: '---\nname: Python Data Science\n...\n# Capabilities...',
  metadata: { 
    tags: ['python', 'data-science'],
    compatible_agents: ['claude-code', 'codex']
  }
}
```

**3. Assistant（助手配置）**

```javascript
{
  type: 'assistant',
  name: 'python-expert',
  content: JSON.stringify({
    system_prompt: '你是 Python 专家...',
    skills: ['python-data-science'],
    prompts: ['code-review'],
    model_preference: { primary: 'claude-sonnet-4-6' }
  })
}
```

**数据模型**：

```sql
-- 统一资源表
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,        -- 'prompt' | 'skill' | 'assistant' | 'template'
  name TEXT NOT NULL,
  content TEXT,
  metadata TEXT,             -- JSON
  source TEXT,               -- 'builtin' | 'github:xxx' | 'sciskill:xxx'
  source_url TEXT
);

-- 资源投射
CREATE TABLE resource_projections (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,    -- 'claude-code' | 'codex'
  target_path TEXT,          -- 投射到的实际路径
  status TEXT                -- 'active' | 'broken'
);
```

**UI 入口**：Resources 页面

```
┌─────────────────────────────────────┐
│  资源管理                            │
├─────────────────────────────────────┤
│  [全部] [Prompt] [Skill] [Assistant]│
├─────────────────────────────────────┤
│  搜索: [____]  [📦 导入] [➕ 创建] │
├─────────────────────────────────────┤
│  📦 Skill (45)                      │
│  ┌───────────────────────────────┐ │
│  │ 🎯 python-data-science        │ │
│  │    标签: python, data         │ │
│  │    已投射: claude-code, codex │ │
│  │    [取消投射] [编辑] [更新]   │ │
│  ├───────────────────────────────┤ │
│  │ 🎯 react-development          │ │
│  │    标签: react, frontend      │ │
│  │    未投射                     │ │
│  │    [投射到...] [编辑]        │ │
│  └───────────────────────────────┘ │
└─────────────────────────────────────┘
```

**优先级**：**P2（次要）**

---

## 🎮 使用模式

Token Bank 支持四种使用模式，用户可自由选择：

### 模式 A：完全独立

```
用户 → Agent (Claude Desktop)
        ↓ 直连
      官方 API

不使用 Token Bank 任何功能
```

### 模式 B：仅使用网关

```
用户 → Agent (Claude Desktop)
        ↓ 通过网关
      Token Bank Gateway
        ↓
      官方 API

✅ 获得：成本追踪、智能路由
❌ 未用：资源管理、Agent 聚合
```

### 模式 C：仅使用资源（重点）

```
用户 → Agent (Claude Desktop)
        ↓ 直连
      官方 API (不走网关)
        +
      Token Bank 资源
        ├─ MCP Server (TB 管理)
        └─ Skill (TB 投射)

✅ 获得：MCP 统一管理、Skill 投射
✅ 保持：直连官方，无代理
❌ 缺失：成本追踪（因不走网关）

典型场景：
  Claude Desktop 配置:
    api_key: sk-ant-xxx (官方)
    mcpServers: {
      "filesystem": {
        "command": "tokenbank-mcp-proxy",
        "args": ["filesystem"]
      }
    }
  Skill: Token Bank 投射到 ~/.config/claude-code/skills/
```

### 模式 D：全部使用

```
用户 → Token Bank Debug 页面
        ↓ 聚合调用
      Agent
        ↓ 通过网关
      Token Bank Gateway
        ↓
      官方 API
        +
      Token Bank 资源 (MCP + Skill)

✅ 获得：所有功能（成本追踪 + 资源管理 + 统一界面）
```

---

## 🔧 技术实现

### 技术栈

**前端**：
- React + JSX
- Electron Renderer
- IPC 通信

**后端**：
- Electron Main Process
- Node.js
- SQLite（数据存储）

**协议**：
- MCP Protocol（stdio/HTTP）
- IPC（Electron）
- REST API（可选）

### 核心模块

**1. AgentExecutor（Agent 执行器）**

```javascript
// client/electron/agent-executor.js
export class AgentExecutor extends EventEmitter {
  async execute(agentId, prompt, options) { /* ... */ }
  async executeClaudeCode(agent, taskId, prompt, options) { /* ... */ }
  async executeCodex(agent, taskId, prompt, options) { /* ... */ }
  async cancel(taskId) { /* ... */ }
}
```

**2. MCPManager（MCP 管理器）**

```javascript
// client/electron/mcp-manager.js
export class MCPManager {
  async startServer(serverId) { /* ... */ }
  async callTool(serverId, toolName, args) { /* ... */ }
  async getFilteredCapabilities(clientId, profileId) { /* ... */ }
  async stopServer(serverId) { /* ... */ }
}
```

**3. ResourceManager（资源管理器）**

```javascript
// client/electron/resource-manager.js
export class ResourceManager {
  async create(resource) { /* ... */ }
  async update(resourceId, updates) { /* ... */ }
  async delete(resourceId) { /* ... */ }
  async search(query, filters) { /* ... */ }
}
```

**4. ResourceProjector（资源投射器）**

```javascript
// client/electron/resource-projector.js
export class ResourceProjector {
  static async project(resourceId, agentId, scope) { /* ... */ }
  static async unproject(projectionId) { /* ... */ }
  static async checkStatus(agentId) { /* ... */ }
  static async repair(agentId) { /* ... */ }
}
```

### IPC 接口

```javascript
// client/electron/main.js

// Agent 聚合
ipcMain.handle('agent:execute', async (event, { agentId, prompt, options }) => {});
ipcMain.handle('agent:cancel', async (event, taskId) => {});
ipcMain.handle('agent:list', async () => {});

// MCP 管理
ipcMain.handle('mcp:start', async (event, serverId) => {});
ipcMain.handle('mcp:stop', async (event, serverId) => {});
ipcMain.handle('mcp:list', async () => {});

// 资源管理
ipcMain.handle('resource:create', async (event, resource) => {});
ipcMain.handle('resource:project', async (event, { resourceId, agentId }) => {});
ipcMain.handle('resource:search', async (event, query) => {});
```

---

## 📋 实施计划

### Phase 1：Agent 聚合系统（核心）

**优先级**：**P0**

**任务清单**：

**1. 数据模型**
- [ ] 创建 `agent_tasks` 表（任务记录）
- [ ] 创建 `agent_task_steps` 表（执行步骤）
- [ ] 创建 `agent_modified_files` 表（文件修改）
- [ ] 扩展 `local_stats` 添加 `agent_id` 列

**2. Agent 执行器**
- [ ] 实现 `AgentExecutor` 类
- [ ] 支持 Claude Code 调用
- [ ] 支持 Codex 调用
- [ ] 支持 Cursor 调用（可选）
- [ ] 实时步骤监听和记录
- [ ] 成本追踪集成

**3. IPC 接口**
- [ ] `agent:execute` - 执行任务
- [ ] `agent:cancel` - 取消任务
- [ ] `agent:list` - 获取可用 Agent
- [ ] `agent:step` - 实时步骤事件

**4. Debug 页面改造**
- [ ] Agent 选择器（从 Gateway 读取）
- [ ] Assistant 选择器
- [ ] 工作目录配置
- [ ] 实时执行日志组件
- [ ] 结果展示组件（文件/统计）
- [ ] 与 Gateway 状态联动

**文件清单**：
```
client/electron/agent-executor.js        (新建)
client/electron/ipc-handlers-agent.js    (新建)
client/src/pages/Debug.jsx               (修改)
client/src/components/AgentSelector.jsx  (新建)
client/src/components/ExecutionLog.jsx   (新建)
client/src/components/ExecutionResult.jsx (新建)
```

---

### Phase 2：MCP 供给源（重要）

**优先级**：**P1**

**任务清单**：

**5. MCP 数据模型**
- [ ] 创建 `mcp_servers` 表
- [ ] 创建 `mcp_capabilities` 表
- [ ] 创建 `mcp_profiles` 表
- [ ] 创建 `mcp_client_bindings` 表
- [ ] 创建 `mcp_call_logs` 表
- [ ] 扩展 `local_stats` 添加 MCP 字段

**6. MCP Manager**
- [ ] 实现 `MCPManager` 类
- [ ] 支持 stdio 模式 MCP Server
- [ ] 支持 HTTP 模式 MCP Server
- [ ] 工具调用和日志记录
- [ ] Profile 过滤机制
- [ ] 配置生成（标准格式）

**7. Providers 页面 MCP 集成**
- [ ] MCP Server 标签页
- [ ] 添加/编辑/删除 MCP Server
- [ ] 启动/停止 MCP Server
- [ ] MCP Profile 管理
- [ ] 客户端绑定管理
- [ ] 日志查看器

**8. Agent + MCP 联动**
- [ ] Agent 执行时注入 MCP 工具
- [ ] MCP 工具调用拦截
- [ ] Debug 页面显示 MCP 工具
- [ ] MCP 成本追踪

**9. MCPMate 集成（可选）**
- [ ] MCPMate 配置导出
- [ ] 配置同步机制

**文件清单**：
```
client/electron/mcp-manager.js           (新建)
client/electron/mcp-proxy-cli.js         (新建 - 可选)
client/electron/ipc-handlers-mcp.js      (新建)
client/src/pages/Providers.jsx           (修改 - MCP标签)
client/src/components/MCPServerCard.jsx  (新建)
client/src/components/MCPProfileEditor.jsx (新建)
```

---

### Phase 3：资源管理系统（次要）

**优先级**：**P2**

**任务清单**：

**10. 数据模型**
- [ ] 创建 `resources` 表
- [ ] 创建 `resource_collections` 表
- [ ] 创建 `resource_projections` 表
- [ ] 创建 `resource_usage` 表

**11. 资源管理器**
- [ ] 实现 `ResourceManager` 类（CRUD）
- [ ] 实现 `ResourceDiscovery` 类（发现和搜索）
- [ ] 实现 `ResourceProjector` 类（投射机制）
- [ ] 实现 `ResourceUpdater` 类（更新机制）

**12. Resources 页面**
- [ ] 资源列表和搜索
- [ ] 资源详情和编辑
- [ ] 导入和创建向导
- [ ] 投射管理界面
- [ ] 资源分类浏览

**13. Gateway 集成**
- [ ] Agent 卡片显示已投射的资源
- [ ] 快速投射/取消投射按钮
- [ ] 投射状态检查和修复

**14. 资源发现**
- [ ] 本地资源扫描
- [ ] sciskillhub API 集成
- [ ] GitHub 资源导入

**文件清单**：
```
client/electron/resource-manager.js      (新建)
client/electron/resource-discovery.js    (新建)
client/electron/resource-projector.js    (新建)
client/electron/ipc-handlers-resource.js (新建)
client/src/pages/Resources.jsx           (新建)
client/src/components/ResourceCard.jsx   (新建)
client/src/components/ResourceEditor.jsx (新建)
client/src/components/ProjectionManager.jsx (新建)
```

---

### Phase 4：测试和优化

**优先级**：**P3**

**任务清单**：

**15. 测试**
- [ ] Agent 执行端到端测试
- [ ] MCP 调用测试
- [ ] 资源管理测试
- [ ] 成本统计验证
- [ ] 跨平台测试（Windows/macOS/Linux）

**16. 优化**
- [ ] 性能优化（大量资源场景）
- [ ] 内存占用优化
- [ ] 日志清理机制
- [ ] 错误恢复机制

**17. 文档**
- [ ] 用户使用文档
- [ ] API 文档
- [ ] 部署文档
- [ ] 故障排查指南

---

## 📚 相关文档

**核心设计文档**：

1. **总体设计**
   - `docs/native-integration-design.md` - 完整设计方案

2. **MCP 供给源**
   - `docs/mcp-supply-source-design.md` - MCP 详细设计
   - `docs/mcp-architecture-comparison.md` - 与 MCPMate 对比

3. **资源管理**
   - `docs/aweskill-aweswitch-integration.md` - Skill/Profile 设计

4. **架构**
   - `docs/modular-architecture.md` - 模块化架构说明

**其他文档**：

5. `docs/agent-aggregator-design.md` - Agent 聚合详细设计
6. `docs/aionui-integration-analysis.md` - AionUi 集成分析

---

## 🎯 核心价值

### 与外部项目对比

| 维度 | AionUi | MCPMate | aweskill | Token Bank |
|-----|--------|---------|----------|-----------|
| **Agent 聚合** | ✅ 核心 | ❌ | ❌ | ✅ 可选入口 |
| **MCP 管理** | ❌ | ✅ 核心 | ❌ | ✅ 轻量管理 |
| **Skill 管理** | ✅ 有 | ❌ | ✅ 核心 | ✅ 资源系统 |
| **成本追踪** | ❌ | ❌ | ❌ | ✅ 全程追踪 |
| **模块化** | ❌ | ❌ | ❌ | ✅ 按需组合 |
| **与已纳管Agent集成** | ❌ | ❌ | ❌ | ✅ 原生集成 |

### Token Bank 的独特优势

**1. 统一平台**
- ✅ Agent + MCP + Skill 三位一体
- ✅ 一个界面，多种能力
- ✅ 数据全打通

**2. 模块化设计**
- ✅ 不是"全有或全无"
- ✅ 按需选择功能模块
- ✅ 渐进式使用

**3. 非侵入性**
- ✅ 不强制改变习惯
- ✅ Agent 聚合是可选的
- ✅ 可直连官方 API

**4. 成本可控**
- ✅ 全链路成本追踪
- ✅ Agent + MCP 统一成本
- ✅ 可视化分析

---

## 📞 总结

Token Bank 通过吸收 AionUi、MCPMate、aweskill 的设计精华，打造了一个：

- 📦 **模块化**：可按需组合使用
- 🎯 **非侵入**：不强制改变用户习惯
- 🔄 **统一管理**：Agent + MCP + Skill 一体化
- 💰 **成本可控**：全链路追踪和分析

**实施优先级**：
- **P0**：Agent 聚合系统（统一入口，实时日志）
- **P1**：MCP 供给源（工具管理，第二维度）
- **P2**：资源管理系统（Skill/Prompt 共享）

---

_整体方案版本：v1.0 | 2026-07-05_
