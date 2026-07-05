# Token Bank 资源管理与能力增强方案

> 吸收 AionUi、aweskill、aweswitch 的设计精华，融合到 Token Bank 现有架构

---

## 🎯 设计原则

### 核心理念

**Token Bank 是主体**，外部项目只是**灵感来源**和**技术参考**：
- ❌ 不做简单的 CLI 封装和集成
- ✅ 吸收其设计思想和技术实现
- ✅ 原生化到 Token Bank 的架构中
- ✅ 统一的用户体验和数据模型

### 三层架构

**1. 资源层**（给 Agent 用的公共资源）
- Prompt 提示词模板
- Skill 技能包
- Assistant 预设配置
- Template 工作流模板

**2. 执行层**（Agent 聚合）
- 统一调用已纳管的 Agent
- 实时执行日志和追踪
- 成本统计

**3. 供给层**（双维度）
- Model Provider：提供推理能力
- MCP Server：提供工具和上下文

---

## 🔀 零、供给源的双维度

### 供给源 = Model Provider + MCP Server

**传统供给源**：只有模型提供商（Anthropic、OpenAI、Google 等）

**增强后的供给源**：
```
维度 1：Model Provider（提供推理能力）
  ├─ Anthropic (Claude)
  ├─ OpenAI (GPT)
  ├─ Google (Gemini)
  └─ ...

维度 2：MCP Server（提供工具和上下文）
  ├─ Filesystem MCP（文件操作）
  ├─ GitHub MCP（代码托管）
  ├─ Database MCP（数据库访问）
  ├─ Web Search MCP（网络搜索）
  └─ Custom MCP（自定义工具）
```

**吸收 MCPMate 的设计**：
- ✅ MCP 代理和管理
- ✅ Profile 机制（场景化工具裁剪）
- ✅ 实时监控和日志
- ❌ 不做独立应用，集成到 Providers 页面

**详细设计**：参见 `docs/mcp-supply-source-design.md`

---

## 📦 一、资源管理系统

### 1.1 核心定位

**资源 = 给 Agent 使用的公共能力**

```
Agent 使用资源的方式：
  
  Claude Code 调用任务时
    ↓ 加载
  Prompt 模板 + Skill 技能包 + Assistant 配置
    ↓ 组合
  增强的 Agent 能力
```

**吸收 aweskill 的核心思想**：
- ✅ 统一管理 Skill/Prompt 等资源
- ✅ 投射机制：资源一次配置，多 Agent 共享
- ✅ 版本管理和更新
- ❌ 不依赖外部 CLI

### 1.2 统一的资源模型

**核心思想**：Skill、Prompt、Assistant、Template 都是**资源**，统一管理，供 Agent 使用

#### 数据模型

```sql
-- 统一资源表
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,  -- 'prompt' | 'skill' | 'assistant' | 'template'
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  content TEXT,        -- Markdown / JSON
  metadata TEXT,       -- JSON：tags, author, version, required_permissions 等
  source TEXT,         -- 来源：'builtin' | 'local' | 'github:<repo>' | 'sciskill:<id>'
  source_url TEXT,     -- 用于更新
  hash TEXT,           -- 内容哈希，用于去重
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(type, name)
);

-- 资源关系表（Bundle/Collection）
CREATE TABLE resource_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'bundle' | 'workflow' | 'project'
  description TEXT,
  metadata TEXT,       -- JSON
  created_at INTEGER
);

CREATE TABLE resource_collection_items (
  collection_id TEXT NOT NULL REFERENCES resource_collections(id),
  resource_id TEXT NOT NULL REFERENCES resources(id),
  position INTEGER,
  PRIMARY KEY(collection_id, resource_id)
);

-- 资源投射表（哪些 Agent 使用了哪些资源）
CREATE TABLE resource_projections (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  agent_id TEXT NOT NULL,  -- 'claude-code' | 'codex' | 'aionui' 等
  scope TEXT NOT NULL,     -- 'global' | 'project:<path>'
  projection_type TEXT,    -- 'symlink' | 'copy' | 'reference'
  target_path TEXT,        -- 实际投射到的路径
  status TEXT,             -- 'active' | 'broken' | 'pending'
  created_at INTEGER
);

-- 资源使用统计
CREATE TABLE resource_usage (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  agent_id TEXT,
  session_id TEXT,
  used_at INTEGER,
  usage_context TEXT       -- JSON：调用场景、效果等
);
```

#### 资源类型

##### 1. Prompt（提示词模板）

**用途**：Agent 调用时使用的提示词模板

```javascript
// 示例：Prompt 资源
{
  type: 'prompt',
  name: 'code-review',
  display_name: '代码审查提示词',
  content: `你是一个资深的代码审查专家...
  
请审查以下代码：
{{code}}

关注点：
{{#if security}}
- 安全漏洞
{{/if}}
{{#if performance}}
- 性能问题
{{/if}}
  `,
  metadata: {
    variables: ['code', 'security', 'performance'],
    tags: ['code', 'review', 'quality'],
    version: '1.0.0',
    author: 'TokenBank Team'
  },
  source: 'builtin'
}

// Agent 使用场景：
// claude-code --prompt "$(render-prompt code-review code=src/app.js security=true)"
```

##### 2. Skill（Agent 技能）

**用途**：Agent 可加载的技能包，增强 Agent 能力

**吸收 aweskill 的设计**：
- SKILL.md 格式（frontmatter + 内容）
- 但不依赖外部 CLI
- 原生存储在 Token Bank 数据库

```javascript
// 示例：Skill 资源
{
  type: 'skill',
  name: 'python-data-science',
  display_name: 'Python 数据科学',
  content: `---
name: Python Data Science
description: Data analysis and visualization with pandas, numpy, matplotlib
tags: [python, data-science, pandas, numpy]
required_permissions: [read_file, write_file, run_code]
---

# Python Data Science Skill

## Capabilities
- Data loading with pandas
- Statistical analysis with numpy
- Visualization with matplotlib/seaborn

## Usage
...
  `,
  metadata: {
    tags: ['python', 'data-science'],
    required_permissions: ['read_file', 'write_file', 'run_code'],
    compatible_agents: ['claude-code', 'codex', 'cursor']
  },
  source: 'sciskill:open-source/data/python-data-science',
  source_url: 'https://sciskillhub.org/api/skills/...'
}

// Agent 使用场景（投射）：
// ~/.aweskill/skills/python-data-science/SKILL.md
//   → symlink/copy 到
// ~/.config/claude-code/skills/python-data-science/SKILL.md
// ~/.config/codex/skills/python-data-science/SKILL.md
```

##### 3. Assistant（助手配置）

**用途**：预设的角色和能力组合，供 Agent 快速应用

**吸收 AionUi 的助手系统**：
- 预设的角色和能力
- 关联的 Skill 和 Prompt
- 但不依赖 AionUi

```javascript
// 示例：Assistant 资源
{
  type: 'assistant',
  name: 'python-expert',
  display_name: 'Python 专家',
  content: `{
    "system_prompt": "你是一个 Python 专家，精通数据科学和 Web 开发...",
    "skills": ["python-data-science", "fastapi-web"],
    "prompts": ["code-review", "refactoring"],
    "tools": ["python_repl", "pytest_runner"],
    "model_preference": {
      "primary": "claude-sonnet-4-6",
      "fallback": ["gemini-2.0-flash-exp"]
    },
    "parameters": {
      "temperature": 0.7,
      "max_tokens": 8000
    }
  }`,
  metadata: {
    tags: ['python', 'expert', 'assistant'],
    capabilities: ['coding', 'data-science', 'web'],
    category: 'development'
  },
  source: 'builtin'
}

// Agent 使用场景：
// Debug 页面选择 "Python 专家" Assistant
//   → 自动加载关联的 Skill 和 Prompt
//   → 使用预设的 system_prompt 和参数
```

##### 4. Template（工作流模板）

**用途**：多步骤工作流配置，Agent 可按模板执行

```javascript
// 示例：Template 资源
{
  type: 'template',
  name: 'api-development-workflow',
  display_name: 'API 开发工作流',
  content: `{
    "steps": [
      {
        "name": "需求分析",
        "assistant": "architect",
        "prompt": "api-requirements-analysis",
        "inputs": ["requirements"]
      },
      {
        "name": "设计 API",
        "assistant": "api-designer",
        "skills": ["openapi", "rest-design"],
        "inputs": ["analysis_result"]
      },
      {
        "name": "生成代码",
        "assistant": "backend-developer",
        "skills": ["fastapi", "python"],
        "inputs": ["api_design"]
      },
      {
        "name": "生成测试",
        "assistant": "qa-engineer",
        "skills": ["pytest", "api-testing"],
        "inputs": ["api_code"]
      }
    ]
  }`,
  metadata: {
    tags: ['workflow', 'api', 'backend'],
    steps_count: 4
  },
  source: 'local'
}

// Agent 使用场景：
// Debug 页面选择 "API 开发工作流" Template
//   → 按步骤自动调用不同的 Assistant
//   → 上一步的输出作为下一步的输入
```

---

### 1.2 资源管理界面

**新增页面**：`client/src/pages/Resources.vue`（或扩展现有 Gateway 页面）

#### UI 设计

```
┌────────────────────────────────────────────────────────┐
│  资源管理                                               │
├────────────────────────────────────────────────────────┤
│  [全部] [Prompt] [Skill] [Assistant] [Template]       │
├────────────────────────────────────────────────────────┤
│  搜索: [____________________]  [📦 导入] [➕ 创建]     │
├────────────────────────────────────────────────────────┤
│                                                        │
│  📝 Prompt (12)                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 📄 code-review          来源: 内置                │ │
│  │    代码审查提示词                                 │ │
│  │    [编辑] [投射] [删除]                           │ │
│  ├──────────────────────────────────────────────────┤ │
│  │ 📄 api-design           来源: GitHub              │ │
│  │    API 设计提示词                                 │ │
│  │    已投射: claude-code, codex                     │ │
│  │    [编辑] [更新] [删除]                           │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  📦 Skill (45)                                         │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 🎯 python-data-science  来源: sciskillhub         │ │
│  │    Python 数据科学技能                            │ │
│  │    标签: python, data, pandas                     │ │
│  │    已投射: claude-code (全局)                     │ │
│  │    [编辑] [更新] [取消投射]                       │ │
│  ├──────────────────────────────────────────────────┤ │
│  │ 🎯 react-development    来源: GitHub              │ │
│  │    React 开发技能                                 │ │
│  │    标签: react, frontend, javascript             │ │
│  │    未投射                                         │ │
│  │    [投射到...] [编辑] [删除]                      │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  🤖 Assistant (8)                                      │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 🎨 ppt-creator          来源: 内置                │ │
│  │    PPT 创建助手                                   │ │
│  │    关联技能: officecli-ppt, design-principles    │ │
│  │    [测试] [编辑] [克隆]                           │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  🔄 Bundle (5)                                         │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 📦 frontend-bundle      包含 8 个资源              │ │
│  │    react, typescript, eslint, prettier...        │ │
│  │    [展开] [投射] [编辑]                           │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

#### 关键功能

**1. 资源发现**

**吸收 aweskill 的发现机制**，但原生化：

```javascript
// client/electron/resource-discovery.js
export class ResourceDiscovery {
  /**
   * 搜索资源
   */
  static async search(query, options = {}) {
    const { type, source, tags } = options;
    
    // 本地搜索
    const localResults = await this.searchLocal(query, { type, tags });
    
    // 远程搜索（如果启用）
    let remoteResults = [];
    if (options.includeRemote) {
      remoteResults = await Promise.all([
        this.searchSciskill(query),
        this.searchGithub(query),
        this.searchSkillsRegistry(query)
      ]);
    }
    
    return {
      local: localResults,
      remote: remoteResults.flat()
    };
  }

  /**
   * 搜索 sciskillhub
   */
  static async searchSciskill(query) {
    const url = `https://sciskillhub.org/api/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    
    return data.skills.map(s => ({
      type: 'skill',
      name: s.id,
      display_name: s.name,
      description: s.description,
      source: `sciskill:${s.id}`,
      source_url: s.download_url,
      metadata: {
        tags: s.tags,
        domain: s.domain,
        stage: s.stage
      }
    }));
  }

  /**
   * 导入资源
   */
  static async import(sourceIdentifier) {
    // 支持多种来源
    if (sourceIdentifier.startsWith('sciskill:')) {
      return await this.importFromSciskill(sourceIdentifier);
    }
    if (sourceIdentifier.startsWith('github:')) {
      return await this.importFromGithub(sourceIdentifier);
    }
    if (sourceIdentifier.startsWith('file:')) {
      return await this.importFromFile(sourceIdentifier);
    }
    
    throw new Error(`Unknown source: ${sourceIdentifier}`);
  }
}
```

**2. 资源投射**

**吸收 aweskill 的投射机制**：

```javascript
// client/electron/resource-projector.js
export class ResourceProjector {
  /**
   * 投射资源到 Agent
   */
  static async project(resourceId, agentId, scope = 'global') {
    const resource = await db.get('SELECT * FROM resources WHERE id = ?', resourceId);
    const agent = AGENT_CONFIGS[agentId];
    
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    
    // 确定目标路径
    const targetPath = scope === 'global' 
      ? agent.globalSkillPath 
      : path.join(scope, agent.projectSkillPath);
    
    // 创建目标目录
    await fs.ensureDir(targetPath);
    
    // 根据资源类型投射
    if (resource.type === 'skill') {
      await this.projectSkill(resource, targetPath);
    } else if (resource.type === 'prompt') {
      await this.projectPrompt(resource, targetPath);
    }
    
    // 记录投射
    await db.run(`
      INSERT INTO resource_projections (id, resource_id, agent_id, scope, target_path, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `, [nanoid(), resourceId, agentId, scope, targetPath]);
    
    return { success: true, targetPath };
  }

  /**
   * 投射 Skill（创建 SKILL.md）
   */
  static async projectSkill(resource, targetPath) {
    const skillDir = path.join(targetPath, resource.name);
    await fs.ensureDir(skillDir);
    
    // 写入 SKILL.md
    const skillPath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillPath, resource.content, 'utf8');
    
    return skillPath;
  }

  /**
   * 检查投射状态
   */
  static async checkProjections(agentId) {
    const projections = await db.all(`
      SELECT p.*, r.name, r.type
      FROM resource_projections p
      JOIN resources r ON r.id = p.resource_id
      WHERE p.agent_id = ?
    `, agentId);
    
    const result = {
      active: [],
      broken: [],
      duplicate: []
    };
    
    for (const proj of projections) {
      const exists = await fs.pathExists(proj.target_path);
      
      if (exists) {
        result.active.push(proj);
      } else {
        result.broken.push(proj);
      }
    }
    
    return result;
  }

  /**
   * 修复损坏的投射
   */
  static async repair(agentId) {
    const status = await this.checkProjections(agentId);
    
    for (const broken of status.broken) {
      await this.project(broken.resource_id, agentId, broken.scope);
    }
    
    return { repaired: status.broken.length };
  }
}
```

**3. 资源更新**

```javascript
// client/electron/resource-updater.js
export class ResourceUpdater {
  /**
   * 检查更新
   */
  static async checkUpdates() {
    const trackedResources = await db.all(`
      SELECT * FROM resources 
      WHERE source_url IS NOT NULL
    `);
    
    const updates = [];
    
    for (const resource of trackedResources) {
      const hasUpdate = await this.checkRemoteVersion(resource);
      if (hasUpdate) {
        updates.push({
          id: resource.id,
          name: resource.name,
          currentVersion: resource.metadata.version,
          remoteVersion: hasUpdate.version
        });
      }
    }
    
    return updates;
  }

  /**
   * 更新资源
   */
  static async update(resourceId) {
    const resource = await db.get('SELECT * FROM resources WHERE id = ?', resourceId);
    
    if (!resource.source_url) {
      throw new Error('Resource has no source URL');
    }
    
    // 获取远程内容
    const remoteContent = await this.fetchRemoteContent(resource.source_url);
    
    // 备份当前版本
    await this.backup(resource);
    
    // 更新内容
    await db.run(`
      UPDATE resources 
      SET content = ?, 
          metadata = ?,
          hash = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      remoteContent.content,
      JSON.stringify(remoteContent.metadata),
      this.hash(remoteContent.content),
      Date.now(),
      resourceId
    ]);
    
    // 重新投射到所有 Agent
    await this.reproject(resourceId);
    
    return { success: true };
  }
}
```

---

## 🤖 二、Agent 聚合系统

### 2.1 核心理念

**吸收 AionUi 的 Agent 聚合思想**，但**不替代原有使用方式**：

```
原有模式（继续支持）：
  用户 → Claude Desktop（直接使用）
  用户 → Codex Desktop（直接使用）
  用户 → Cursor（直接使用）
  ✅ 用户仍可在各 Agent 端直接操作

新增模式（可选入口）：
  用户 → Token Bank (Debug 聚合入口)
              ├─ 已纳管的 Agent（Gateway 中管理）
              ├─ 统一调用接口
              ├─ 实时执行反馈
              └─ 成本统一追踪
  
  ✅ 只是提供额外的便利
  ✅ 不强制改变用户习惯
  ✅ 两种方式并存，自由选择
```

### 2.2 设计原则

**1. 非侵入性**
- ❌ 不修改 Agent 原有配置（除了纳管网关）
- ❌ 不阻止用户在 Agent 端直接操作
- ✅ Debug 页面只是一个**可选的统一入口**

**2. 增值性**
- ✅ 统一界面：不用切换多个 Agent 窗口
- ✅ 成本追踪：每次调用都有成本记录
- ✅ 资源共享：Skill/Prompt 一次配置，多处使用
- ✅ 实时日志：可视化执行过程

**3. 兼容性**
- ✅ 用户在 Claude Desktop 的操作 → 成本仍追踪（通过网关）
- ✅ 用户在 Debug 页面的操作 → 同样的成本追踪
- ✅ 数据统一：无论哪种方式，都记录在 local_stats

**使用场景对比**：

| 场景 | 原有方式 | Agent 聚合 |
|-----|---------|-----------|
| **日常开发** | Claude Desktop | ✅ 可用 |
| **代码编辑** | Cursor | ✅ 可用 |
| **快速任务** | Codex CLI | ✅ 可用 |
| **跨 Agent 协同** | ❌ 需切换多个窗口 | ✅ 一个界面搞定 |
| **成本追踪** | ✅ 通过网关自动记录 | ✅ 实时显示 |
| **执行日志** | ❌ 只在 Agent 端看 | ✅ 统一查看 |

### 2.3 Agent 聚合架构

#### 数据模型

```sql
-- Agent 注册表（从 Gateway 已纳管的 Agent 中读取）
CREATE TABLE managed_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,      -- 'claude-code' | 'codex' | 'cursor' | 'aider' 等
  executable_path TEXT,    -- 可执行文件路径
  config_path TEXT,        -- 配置文件路径
  status TEXT,             -- 'active' | 'inactive' | 'error'
  capabilities TEXT,       -- JSON: ['code', 'chat', 'edit', 'terminal'] 等
  version TEXT,
  last_detected INTEGER,
  metadata TEXT            -- JSON
);

-- Agent 执行任务
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES managed_agents(id),
  prompt TEXT NOT NULL,
  context TEXT,            -- JSON：工作目录、文件等上下文
  status TEXT NOT NULL,    -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  result TEXT,             -- JSON：执行结果
  error TEXT,              -- 错误信息
  created_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER
);

-- 任务步骤（Agent 执行过程）
CREATE TABLE agent_task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  step_number INTEGER,
  step_type TEXT,          -- 'thinking' | 'tool_call' | 'code_edit' | 'terminal' | 'result'
  content TEXT,            -- 步骤内容
  tool_name TEXT,          -- 工具名称（如果是 tool_call）
  tool_input TEXT,         -- 工具输入
  tool_output TEXT,        -- 工具输出
  status TEXT,             -- 'running' | 'completed' | 'failed'
  created_at INTEGER
);

-- 生成/修改的文件
CREATE TABLE agent_modified_files (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  file_path TEXT NOT NULL,
  operation TEXT,          -- 'create' | 'modify' | 'delete'
  diff TEXT,               -- 文件差异
  created_at INTEGER
);

-- Agent 使用统计（复用现有 local_stats，扩展 agent_id）
-- 已有表，只需添加 agent_id 列
ALTER TABLE local_stats ADD COLUMN agent_id TEXT;
```

### 2.4 Agent 执行器

**统一的 Agent 调用接口**：

```javascript
// client/electron/agent-executor.js
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class AgentExecutor extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.runningTasks = new Map(); // taskId → process
  }

  /**
   * 获取可用 Agent 列表
   */
  async listAvailableAgents() {
    const agents = await this.db.all(`
      SELECT * FROM managed_agents 
      WHERE status = 'active'
      ORDER BY name
    `);
    
    return agents.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      capabilities: JSON.parse(a.capabilities || '[]'),
      version: a.version
    }));
  }

  /**
   * 执行 Agent 任务
   */
  async execute(agentId, prompt, options = {}) {
    const agent = await this.db.get(
      'SELECT * FROM managed_agents WHERE id = ?',
      agentId
    );
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // 创建任务记录
    const taskId = this.generateTaskId();
    await this.db.run(`
      INSERT INTO agent_tasks (id, agent_id, prompt, context, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `, [taskId, agentId, prompt, JSON.stringify(options), Date.now()]);

    // 根据 Agent 类型调用
    try {
      await this.db.run(
        'UPDATE agent_tasks SET status = ?, started_at = ? WHERE id = ?',
        ['running', Date.now(), taskId]
      );

      let result;
      if (agent.type === 'claude-code') {
        result = await this.executeClaudeCode(agent, taskId, prompt, options);
      } else if (agent.type === 'codex') {
        result = await this.executeCodex(agent, taskId, prompt, options);
      } else if (agent.type === 'cursor') {
        result = await this.executeCursor(agent, taskId, prompt, options);
      } else if (agent.type === 'aider') {
        result = await this.executeAider(agent, taskId, prompt, options);
      } else {
        throw new Error(`Unsupported agent type: ${agent.type}`);
      }

      // 更新任务状态
      await this.db.run(`
        UPDATE agent_tasks 
        SET status = 'completed', result = ?, completed_at = ?
        WHERE id = ?
      `, [JSON.stringify(result), Date.now(), taskId]);

      // 记录成本
      await this.recordCost(taskId, result);

      return { taskId, result };
    } catch (error) {
      await this.db.run(`
        UPDATE agent_tasks 
        SET status = 'failed', error = ?, completed_at = ?
        WHERE id = ?
      `, [error.message, Date.now(), taskId]);
      
      throw error;
    }
  }

  /**
   * 执行 Claude Code
   */
  async executeClaudeCode(agent, taskId, prompt, options) {
    const { workingDir = process.cwd() } = options;

    return new Promise((resolve, reject) => {
      const args = ['--prompt', prompt];
      if (workingDir) args.push('--cwd', workingDir);

      const proc = spawn(agent.executable_path, args, {
        cwd: workingDir,
        env: { ...process.env }
      });

      let stdout = '';
      let stderr = '';
      const steps = [];
      let stepCounter = 0;

      proc.stdout.on('data', async (data) => {
        stdout += data.toString();
        
        // 解析实时输出，提取步骤
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          
          // 发送实时事件
          this.emit('step', { taskId, content: line });
          
          // 记录步骤
          await this.recordStep(taskId, {
            step_number: stepCounter++,
            step_type: this.detectStepType(line),
            content: line
          });
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', async (code) => {
        this.runningTasks.delete(taskId);
        
        if (code === 0) {
          // 检测修改的文件
          const modifiedFiles = await this.detectModifiedFiles(workingDir);
          
          resolve({
            success: true,
            output: stdout,
            files: modifiedFiles,
            steps: steps.length
          });
        } else {
          reject(new Error(`Agent exited with code ${code}: ${stderr}`));
        }
      });

      // 保存进程引用，用于取消
      this.runningTasks.set(taskId, proc);
    });
  }

  /**
   * 执行 Codex
   */
  async executeCodex(agent, taskId, prompt, options) {
    // 类似 Claude Code，但使用 Codex CLI
    // codex --prompt "..." --cwd /path
  }

  /**
   * 执行 Cursor
   */
  async executeCursor(agent, taskId, prompt, options) {
    // Cursor 可能通过 CLI 或 IPC
  }

  /**
   * 执行 Aider
   */
  async executeAider(agent, taskId, prompt, options) {
    // aider --message "..." --yes-always
  }

  /**
   * 取消任务
   */
  async cancel(taskId) {
    const proc = this.runningTasks.get(taskId);
    if (proc) {
      proc.kill('SIGTERM');
      this.runningTasks.delete(taskId);
      
      await this.db.run(`
        UPDATE agent_tasks 
        SET status = 'cancelled', completed_at = ?
        WHERE id = ?
      `, [Date.now(), taskId]);
    }
  }

  /**
   * 记录步骤
   */
  async recordStep(taskId, step) {
    await this.db.run(`
      INSERT INTO agent_task_steps 
      (id, task_id, step_number, step_type, content, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'completed', ?)
    `, [
      this.generateStepId(),
      taskId,
      step.step_number,
      step.step_type,
      step.content,
      Date.now()
    ]);
  }

  /**
   * 检测步骤类型
   */
  detectStepType(line) {
    if (line.includes('Thinking:')) return 'thinking';
    if (line.includes('Tool:')) return 'tool_call';
    if (line.includes('Edit:')) return 'code_edit';
    if (line.includes('Run:')) return 'terminal';
    return 'output';
  }

  /**
   * 检测修改的文件
   */
  async detectModifiedFiles(workingDir) {
    // 通过 git diff 或文件时间戳检测
    // 简化实现：返回空数组
    return [];
  }

  /**
   * 记录成本
   */
  async recordCost(taskId, result) {
    const task = await this.db.get(
      'SELECT * FROM agent_tasks WHERE id = ?',
      taskId
    );
    
    // 从 result 中提取 token 和 cost
    const { tokens, cost } = this.extractCostInfo(result);
    
    if (tokens || cost) {
      const agent = await this.db.get(
        'SELECT * FROM managed_agents WHERE id = ?',
        task.agent_id
      );
      
      // 写入 local_stats
      await this.db.run(`
        INSERT INTO local_stats 
        (id, model, input_tokens, output_tokens, total_cost, timestamp, agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        this.generateStatsId(),
        `agent:${agent.type}`,
        tokens?.input || 0,
        tokens?.output || 0,
        cost || 0,
        Date.now(),
        agent.id
      ]);
    }
  }

  extractCostInfo(result) {
    // 从 Agent 输出中提取 token 和 cost
    // 不同 Agent 格式不同，需要适配
    return { tokens: null, cost: null };
  }

  generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  generateStepId() {
    return `step_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  generateStatsId() {
    return `stats_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
```

### 2.5 Debug 页面：Agent 聚合入口

**核心定位**：**可选的**统一 Agent 操作台，不替代原有使用方式

**说明**：
- ✅ 用户仍可在 Claude Desktop、Codex、Cursor 中直接操作
- ✅ Debug 页面提供统一入口，用于跨 Agent 场景和成本可视化
- ✅ 无论哪种方式，成本都通过网关追踪

#### UI 设计

```
┌────────────────────────────────────────────────────────┐
│  Agent 操作台                          [模式: Agent ▼] │
├────────────────────────────────────────────────────────┤
│                                                        │
│  选择 Agent:                                           │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 🤖 Claude Code v1.2.3    [claude-code]           │ │
│  │    能力: code, chat, edit, terminal              │ │
│  │    状态: ✅ 已纳管 · 已配置 Token Bank 网关       │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ ▼ Codex v2.1.0          [codex]                  │ │
│  │ ▼ Cursor Agent          [cursor]                 │ │
│  │ ▼ Aider v0.45.0         [aider]                  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  工作目录: [/Users/me/project]              [浏览...] │
│                                                        │
│  ┌────────────────────────────────────────────────┐   │
│  │ 输入任务:                                       │   │
│  │                                                 │   │
│  │ 帮我重构 src/utils.js，提取公共函数，添加单元测试 │   │
│  │                                                 │   │
│  └────────────────────────────────────────────────┘   │
│                                  [取消] [▶ 执行 Agent] │
├────────────────────────────────────────────────────────┤
│  执行过程 (Task: task_123456)                          │
│  ┌──────────────────────────────────────────────────┐ │
│  │ [10:23:45] 🤔 Thinking: 分析 utils.js 结构...    │ │
│  │ [10:23:47] 🔧 Tool: read_file(src/utils.js)     │ │
│  │ [10:23:48] ✏️  Edit: 提取 formatDate 函数        │ │
│  │            - 创建 src/utils/date.js              │ │
│  │            - 修改 src/utils.js                   │ │
│  │ [10:23:50] 🔧 Tool: write_file(test/utils.test.js)│ │
│  │ [10:23:52] 🏃 Run: npm test                      │ │
│  │            ✅ All tests passed (5/5)             │ │
│  │ [10:23:55] ✅ Completed                          │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  执行结果                                               │
│  ┌──────────────────────────────────────────────────┐ │
│  │ ✅ 任务完成                                       │ │
│  │                                                   │ │
│  │ 修改的文件 (3):                                   │ │
│  │  📝 src/utils.js           -42 +15               │ │
│  │  📝 src/utils/date.js      +58 (新建)            │ │
│  │  📝 test/utils.test.js     +120 (新建)           │ │
│  │                                                   │ │
│  │ 执行统计:                                         │ │
│  │  ⏱️  耗时: 12.3s                                  │ │
│  │  🔤 Tokens: 3,245 (输入) + 1,892 (输出)          │ │
│  │  💰 成本: $0.0234                                │ │
│  │  📊 步骤: 6 个                                   │ │
│  │                                                   │ │
│  │ [📁 在文件管理器中打开] [🔄 查看差异]             │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

#### 与 Gateway 的联动

**从 Gateway 读取已纳管的 Agent**：

```javascript
// Gateway 页面已有 Agent 检测
const detectedAgents = [
  { id: 'claude-code', name: 'Claude Code', status: 'linked' },
  { id: 'codex', name: 'Codex Desktop', status: 'linked' },
  { id: 'cursor', name: 'Cursor', status: 'detected' }
];

// Debug 页面直接使用
const availableAgents = detectedAgents.filter(a => a.status === 'linked');
```

**Agent 状态同步**：
- Gateway 纳管 → Debug 立即可用
- Gateway 取消纳管 → Debug 自动移除
- 统一的配置和状态管理

#### 前端实现

```jsx
// client/src/pages/Debug.jsx
function AgentMode({ agents }) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [workingDir, setWorkingDir] = useState(process.cwd());
  const [prompt, setPrompt] = useState('');
  const [task, setTask] = useState(null);
  const [steps, setSteps] = useState([]);
  const [result, setResult] = useState(null);

  // 执行 Agent
  const handleExecute = async () => {
    if (!selectedAgent || !prompt) return;

    try {
      // 调用 IPC
      const taskId = await window.electronAPI.agent.execute({
        agentId: selectedAgent.id,
        prompt,
        workingDir
      });

      setTask({ id: taskId, status: 'running' });
      setSteps([]);

      // 监听实时步骤
      window.electronAPI.agent.onStep((step) => {
        if (step.taskId === taskId) {
          setSteps(prev => [...prev, step]);
        }
      });

      // 等待完成
      const result = await window.electronAPI.agent.waitForCompletion(taskId);
      setResult(result);
      setTask({ id: taskId, status: 'completed' });
    } catch (error) {
      console.error('Agent execution failed:', error);
      setTask({ id: task?.id, status: 'failed', error: error.message });
    }
  };

  return (
    <div className="agent-mode">
      {/* Agent 选择器 */}
      <div className="agent-selector">
        <h3>选择 Agent:</h3>
        {agents.map(agent => (
          <AgentCard
            key={agent.id}
            agent={agent}
            selected={selectedAgent?.id === agent.id}
            onClick={() => setSelectedAgent(agent)}
          />
        ))}
      </div>

      {/* 工作目录 */}
      <div className="working-dir">
        <label>工作目录:</label>
        <input
          type="text"
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
        />
        <button onClick={handleBrowseDir}>浏览...</button>
      </div>

      {/* 任务输入 */}
      <div className="task-input">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="输入任务..."
          rows={4}
        />
        <div className="actions">
          <button onClick={handleCancel} disabled={task?.status !== 'running'}>
            取消
          </button>
          <button onClick={handleExecute} disabled={!selectedAgent || !prompt}>
            ▶ 执行 Agent
          </button>
        </div>
      </div>

      {/* 执行过程 */}
      {task && (
        <div className="execution-log">
          <h3>执行过程 (Task: {task.id})</h3>
          <div className="steps">
            {steps.map((step, i) => (
              <StepDisplay key={i} step={step} />
            ))}
          </div>
        </div>
      )}

      {/* 执行结果 */}
      {result && (
        <div className="execution-result">
          <h3>执行结果</h3>
          <ResultDisplay result={result} />
        </div>
      )}
    </div>
  );
}

function StepDisplay({ step }) {
  const icons = {
    thinking: '🤔',
    tool_call: '🔧',
    code_edit: '✏️',
    terminal: '🏃',
    output: '📄'
  };

  return (
    <div className={`step step-${step.type}`}>
      <span className="time">[{formatTime(step.timestamp)}]</span>
      <span className="icon">{icons[step.type] || '📄'}</span>
      <span className="content">{step.content}</span>
    </div>
  );
}

function ResultDisplay({ result }) {
  return (
    <div className="result">
      <div className="status">
        {result.success ? '✅ 任务完成' : '❌ 任务失败'}
      </div>

      {result.files && result.files.length > 0 && (
        <div className="modified-files">
          <h4>修改的文件 ({result.files.length}):</h4>
          {result.files.map(file => (
            <div key={file.path} className="file-item">
              <span className="icon">📝</span>
              <span className="path">{file.path}</span>
              <span className="stats">
                {file.operation === 'create' && '(新建)'}
                {file.operation === 'modify' && `${file.diff?.additions || 0}+ ${file.diff?.deletions || 0}-`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="stats">
        <h4>执行统计:</h4>
        <div className="stat-item">
          <span>⏱️ 耗时:</span>
          <span>{result.duration}s</span>
        </div>
        <div className="stat-item">
          <span>🔤 Tokens:</span>
          <span>{result.tokens?.input || 0} (输入) + {result.tokens?.output || 0} (输出)</span>
        </div>
        <div className="stat-item">
          <span>💰 成本:</span>
          <span>${result.cost?.toFixed(4) || '0.0000'}</span>
        </div>
        <div className="stat-item">
          <span>📊 步骤:</span>
          <span>{result.steps} 个</span>
        </div>
      </div>

      <div className="actions">
        <button onClick={() => openInExplorer(result.workingDir)}>
          📁 在文件管理器中打开
        </button>
        {result.files && (
          <button onClick={() => showDiff(result.files)}>
            🔄 查看差异
          </button>
        )}
      </div>
    </div>
  );
}
```

#### IPC 接口

```javascript
// client/electron/main.js

// Agent 执行
ipcMain.handle('agent:execute', async (event, { agentId, prompt, workingDir }) => {
  const executor = new AgentExecutor(db);
  const { taskId } = await executor.execute(agentId, prompt, { workingDir });
  
  // 监听步骤，转发到前端
  executor.on('step', (step) => {
    event.sender.send('agent:step', step);
  });
  
  return taskId;
});

// 等待完成
ipcMain.handle('agent:wait', async (event, taskId) => {
  const task = await db.get('SELECT * FROM agent_tasks WHERE id = ?', taskId);
  
  // 如果还在运行，等待
  if (task.status === 'running') {
    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        const updated = await db.get('SELECT * FROM agent_tasks WHERE id = ?', taskId);
        if (updated.status !== 'running') {
          clearInterval(checkInterval);
          resolve(JSON.parse(updated.result || '{}'));
        }
      }, 500);
    });
  }
  
  return JSON.parse(task.result || '{}');
});

// 取消任务
ipcMain.handle('agent:cancel', async (event, taskId) => {
  const executor = new AgentExecutor(db);
  await executor.cancel(taskId);
});

// 获取可用 Agent
ipcMain.handle('agent:list', async () => {
  const executor = new AgentExecutor(db);
  return await executor.listAvailableAgents();
});
```

---

## 🔄 三、统一的数据流

### 3.1 架构图

```
┌──────────────────────────────────────────────────────┐
│  前端 UI（统一体验）                                   │
│  ├─ Resources 页面（资源管理）                        │
│  ├─ Gateway 页面（Agent 纳管 + 投射）                │
│  └─ Debug 页面（Agent 模式 + Assistant）             │
└────────────┬─────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────┐
│  Electron 主进程（业务逻辑）                          │
│  ├─ ResourceManager（资源生命周期）                  │
│  ├─ ResourceDiscovery（资源发现）                    │
│  ├─ ResourceProjector（资源投射）                    │
│  ├─ AgentExecutor（Agent 执行）                      │
│  └─ OfficeTools（Office 能力）                       │
└────────────┬─────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────┐
│  数据层（SQLite）                                     │
│  ├─ resources（统一资源表）                          │
│  ├─ resource_collections（Bundle/Workflow）         │
│  ├─ resource_projections（投射关系）                │
│  └─ agent_tasks（执行记录）                          │
└──────────────────────────────────────────────────────┘
```

### 3.2 集成点

| 外部项目能力 | Token Bank 原生实现 | 集成方式 | 优先级 |
|------------|-------------------|---------|-------|
| **AionUi Agent 聚合** | Agent 聚合系统 + Debug 页面 | 吸收架构设计，调用已纳管 Agent | **P0** |
| **AionUi 多 Agent 协同** | AgentExecutor 统一调用接口 | 原生实现，支持多种 Agent | **P0** |
| **AionUi 执行追踪** | agent_tasks / agent_task_steps 表 | 实时记录，可视化展示 | **P0** |
| **MCPMate MCP 代理** | MCP Manager + Providers 页面 | 吸收设计，原生实现 | **P1** |
| **MCPMate Profile 裁剪** | mcp_profiles 表 + 过滤机制 | 场景化工具管理 | **P1** |
| **MCPMate 实时监控** | mcp_call_logs + local_stats | 日志和成本追踪 | **P1** |
| **aweskill Skill 管理** | Resource 系统 | 吸收数据模型和投射机制 | **P2** |
| **aweskill 发现/更新** | ResourceDiscovery | 复用 API，原生界面 | **P2** |
| **AionUi Assistant** | Assistant 资源类型 | 原生配置格式 | **P3** |

**说明**：
- **P0**：核心功能，优先实现（Agent 聚合）
- **P1**：重要功能，第二阶段（MCP 供给源）
- **P2**：次要功能，第三阶段（资源管理）
- **P3**：可选功能，看需求（Assistant）

---

## 📋 实施计划

### 核心目标

1. **Agent 聚合**：统一入口调用 Gateway 已纳管的 Agent
2. **MCP 供给源**：将 MCP Server 作为第二类供给源
3. **资源管理**：Skill/Prompt 统一管理和投射

### Phase 1：Agent 聚合系统（核心）

**1. 数据模型**
- [ ] 创建 agent_tasks / agent_task_steps / agent_modified_files 表
- [ ] 扩展 local_stats 添加 agent_id 列
- [ ] 创建 managed_agents 表（或复用 Gateway 数据）

**2. Agent 执行器**
- [ ] 实现 AgentExecutor 类
- [ ] 支持 Claude Code 调用
- [ ] 支持 Codex 调用
- [ ] 支持其他 Agent（Cursor/Aider）
- [ ] 实时步骤监听和记录

**3. IPC 接口**
- [ ] agent:execute（执行任务）
- [ ] agent:cancel（取消任务）
- [ ] agent:list（获取可用 Agent）
- [ ] agent:step（实时步骤事件）

**4. Debug 页面改造**
- [ ] Agent 选择器（从 Gateway 读取）
- [ ] 工作目录配置
- [ ] 实时执行日志
- [ ] 结果展示（文件/统计）
- [ ] 与 Gateway 状态联动

### Phase 2：MCP 供给源（重要）

**5. MCP 数据模型**
- [ ] 创建 mcp_servers / mcp_capabilities / mcp_profiles 表
- [ ] 创建 mcp_client_bindings / mcp_call_logs 表
- [ ] 扩展 local_stats 添加 MCP 字段

**6. MCP Manager**
- [ ] 实现 MCPManager 类
- [ ] 支持 stdio 模式 MCP 服务器
- [ ] 支持 HTTP 模式 MCP 服务器
- [ ] 工具调用和日志记录
- [ ] Profile 过滤机制

**7. Providers 页面 MCP 集成**
- [ ] MCP Server 标签页
- [ ] 添加/编辑/删除 MCP Server
- [ ] 启动/停止 MCP Server
- [ ] MCP Profile 管理
- [ ] 客户端绑定管理

**8. Agent + MCP 联动**
- [ ] Agent 执行时注入 MCP 工具
- [ ] MCP 工具调用拦截
- [ ] Debug 页面显示 MCP 工具
- [ ] MCP 成本追踪

### Phase 3：资源管理系统

**9. 数据模型**
- [ ] 创建 resources / resource_collections / resource_projections 表
- [ ] 支持 Prompt / Skill / Assistant / Template 类型

**10. 资源发现和管理**
- [ ] ResourceDiscovery（本地 + sciskillhub）
- [ ] ResourceManager（CRUD）
- [ ] ResourceProjector（投射到 Agent）
- [ ] 资源更新机制

**11. Resources 页面**
- [ ] 资源列表和搜索
- [ ] 资源详情和编辑
- [ ] 导入和创建
- [ ] 投射管理

**12. Gateway 集成**
- [ ] Agent 卡片显示已投射的资源
- [ ] 快速投射/取消投射
- [ ] 投射状态检查和修复

### Phase 4：Assistant 系统（可选）

**13. Assistant 资源**
- [ ] Assistant 资源类型定义
- [ ] 与 Skill/Prompt 关联
- [ ] Debug 页面 Assistant 选择
- [ ] Assistant 预设模板

### Phase 5：测试优化

**14. 测试和完善**
- [ ] Agent 执行端到端测试
- [ ] MCP 调用测试
- [ ] 资源管理测试
- [ ] 成本统计验证
- [ ] 性能优化
- [ ] 文档完善

---

## 🎯 优先级

### P0（最高优先级）
- **Agent 聚合系统**：Debug 页面作为统一 Agent 入口
- 支持 Claude Code 和 Codex
- 实时执行日志和成本追踪

### P1（重要）
- **MCP 供给源**：将 MCP Server 纳入供给源体系
- MCP Manager 和 Providers 页面集成
- Agent + MCP 联动

### P2（次要）
- **资源管理**：Skill/Prompt 统一管理
- 资源投射到 Agent
- Resources 页面

### P3（可选）
- Assistant 系统
- 更多 Agent 支持（Cursor/Aider）
- 高级功能（Bundle/Workflow）

---

## 🎯 核心价值

### 与 AionUi 的对比

| 维度 | AionUi | Token Bank 原生方案 |
|-----|--------|-------------------|
| **交互方式** | 独立应用，需切换 | 可选入口，不强制 |
| **原有使用** | 需改变习惯 | ✅ 保持原有习惯 |
| **Agent 管理** | 内置 Agent | 调用已纳管的 Agent |
| **成本追踪** | 无 | ✅ 全程追踪（无论哪种方式） |
| **配置管理** | 独立配置 | 统一网关配置 |
| **数据存储** | 独立数据库 | 统一 SQLite |
| **用户体验** | 需适应新应用 | 提供可选便利 |

### 核心优势

**1. Agent 聚合（可选入口）**
- ✅ 统一入口：一个界面调用所有 Agent（可选）
- ✅ 原生兼容：不影响在 Agent 端直接操作
- ✅ 实时反馈：执行过程可视化
- ✅ 成本可控：每次调用都有成本追踪（无论哪种方式）

**2. 资源管理**
- ✅ 统一模型：Prompt/Skill/Assistant 一致管理
- ✅ 投射机制：一次配置，多 Agent 共享
- ✅ 版本控制：资源更新和回滚
- ✅ 来源多样：本地、GitHub、sciskillhub

**3. MCP 供给源**
- ✅ 双维度供给：Model（推理）+ MCP（工具）
- ✅ 统一管理：Providers 页面集成
- ✅ Profile 裁剪：场景化减少 token 消耗
- ✅ 实时监控：日志、统计、告警

**4. 数据打通**
- ✅ 成本统一：Agent 调用纳入 Token Bank 成本体系
- ✅ 会话关联：Agent 任务与会话记录关联
- ✅ 统计分析：Agent 使用情况可视化

### 用户收益

- **保持习惯**：可以继续在熟悉的 Agent 端操作，不强制改变
- **可选增值**：需要时使用 Debug 页面的统一入口，获得额外便利
- **成本透明**：无论哪种方式，都有完整的成本追踪
- **资源共享**：Skill/Prompt 统一管理，团队协作更高效
- **灵活扩展**：原生架构，易于添加新 Agent 和新能力

---

_融合方案版本：v1.0 | 2026-07-05_
