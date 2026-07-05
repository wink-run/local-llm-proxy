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

### 架构定位

```
┌────────────────────────────────────────────────────────┐
│  Token Bank（本地 LLM 中枢）                            │
│                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│
│  │  资源管理    │  │  供给管理    │  │  执行引擎    ││
│  │              │  │              │  │              ││
│  │  • Prompt    │  │  • Provider  │  │  • Agent     ││
│  │  • Skill     │  │  • MCP       │  │  • Executor  ││
│  │  • Assistant │  │  • Route     │  │  • Tool      ││
│  │  • Template  │  │  • Profile   │  │  • Workflow  ││
│  └──────────────┘  └──────────────┘  └──────────────┘│
│                                                        │
│  统一的数据模型 · 统一的 UI · 统一的体验                 │
└────────────────────────────────────────────────────────┘

        ↑ 吸收设计思想
        │
┌───────┴─────────┬──────────────┬──────────────┐
│                 │              │              │
│  AionUi         │  aweskill    │  aweswitch   │
│  • Office 能力  │  • Skill 管理│  • Profile   │
│  • Agent 引擎   │  • Bundle    │  • 快速切换  │
│  • 助手系统     │  • 投射机制  │  • 配置隔离  │
└─────────────────┴──────────────┴──────────────┘
    只是参考，不做直接集成
```

---

## 📦 一、资源管理系统

### 1.1 统一的资源模型

**核心思想**：Skill、Prompt、Assistant、Template 都是**资源**

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
```

##### 2. Skill（Agent 技能）

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
```

##### 3. Assistant（助手配置）

**吸收 AionUi 的助手系统**：
- 预设的角色和能力
- 关联的 Skill 和 Prompt
- 但不依赖 AionUi

```javascript
// 示例：Assistant 资源
{
  type: 'assistant',
  name: 'ppt-creator',
  display_name: 'PPT 创建助手',
  content: `{
    "system_prompt": "你是一个专业的 PPT 制作专家...",
    "skills": ["officecli-ppt", "design-principles"],
    "prompts": ["ppt-structure", "slide-design"],
    "tools": ["pptx_generator", "image_search"],
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
    tags: ['office', 'ppt', 'presentation'],
    capabilities: ['ppt-generation', 'design'],
    category: 'productivity'
  },
  source: 'builtin'
}
```

##### 4. Template（工作流模板）

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

## 🤖 二、Agent 执行增强

### 2.1 内置 Agent 引擎

**吸收 AionUi 的 Agent 引擎设计**，但原生到 Token Bank：

#### 数据模型

```sql
-- Agent 执行任务
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,      -- 'chat' | 'office' | 'code' | 'workflow'
  assistant_id TEXT,       -- 关联 Assistant 资源
  prompt TEXT NOT NULL,
  context TEXT,            -- JSON：文件、变量等上下文
  status TEXT NOT NULL,    -- 'pending' | 'running' | 'completed' | 'failed'
  result TEXT,             -- JSON：执行结果
  metadata TEXT,           -- JSON：模型、Token、成本等
  created_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER
);

-- 任务步骤（执行跟踪）
CREATE TABLE agent_task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  step_number INTEGER,
  name TEXT,
  status TEXT,             -- 'pending' | 'running' | 'completed' | 'failed'
  tool_calls TEXT,         -- JSON
  result TEXT,
  started_at INTEGER,
  completed_at INTEGER
);

-- 生成的文件
CREATE TABLE agent_generated_files (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  file_path TEXT NOT NULL,
  file_type TEXT,          -- 'pptx' | 'docx' | 'xlsx' | 'md' | 'code'
  file_size INTEGER,
  preview_path TEXT,       -- 预览图路径
  created_at INTEGER
);
```

#### Office 能力实现

**借鉴 AionUi 的 OfficeCLI 集成**：

```javascript
// client/electron/office-tools.js
export class OfficeTools {
  /**
   * 生成 PPT
   */
  static async generatePPT(params) {
    const { title, content, style, outputPath } = params;
    
    // 使用 Agent 生成 PPT 结构
    const structure = await this.generatePPTStructure(title, content);
    
    // 调用 OfficeCLI 或类似工具生成实际文件
    const result = await this.executePPTGeneration(structure, style, outputPath);
    
    return {
      success: true,
      filePath: result.path,
      previewPath: result.preview,
      metadata: result.metadata
    };
  }

  /**
   * 生成 Word 文档
   */
  static async generateWord(params) {
    // 类似逻辑
  }

  /**
   * 生成 Excel 表格
   */
  static async generateExcel(params) {
    // 类似逻辑
  }
}
```

### 2.2 Debug 页面的 Agent 模式增强

**结合资源管理和 Office 能力**：

```jsx
// Agent 模式增强
<div className="agent-mode">
  {/* Assistant 选择 */}
  <select value={selectedAssistant} onChange={...}>
    <option value="">通用对话</option>
    <optgroup label="内置助手">
      <option value="ppt-creator">📊 PPT 创建助手</option>
      <option value="word-creator">📝 Word 创建助手</option>
      <option value="excel-creator">📗 Excel 创建助手</option>
      <option value="code-reviewer">🔍 代码审查助手</option>
    </optgroup>
    <optgroup label="自定义助手">
      {customAssistants.map(a => (
        <option key={a.id} value={a.id}>{a.display_name}</option>
      ))}
    </optgroup>
  </select>

  {/* 关联的 Skills 显示 */}
  {selectedAssistant && (
    <div className="assistant-skills">
      <span>已加载技能:</span>
      {assistantSkills.map(s => (
        <span key={s} className="skill-badge">{s}</span>
      ))}
    </div>
  )}

  {/* 对话区增强显示 */}
  <div className="chat-area">
    {messages.map(msg => {
      if (msg.type === 'office_generation') {
        return (
          <div className="office-result">
            <h4>✅ {msg.fileType} 已生成</h4>
            <div className="file-preview">
              <img src={msg.previewPath} alt="preview" />
            </div>
            <div className="file-actions">
              <button onClick={() => openFile(msg.filePath)}>
                打开文件
              </button>
              <button onClick={() => showInFolder(msg.filePath)}>
                显示位置
              </button>
            </div>
            <div className="generation-stats">
              <span>耗时: {msg.duration}s</span>
              <span>Token: {msg.tokens}</span>
              <span>成本: ${msg.cost}</span>
            </div>
          </div>
        );
      }
      
      return <NormalMessage message={msg} />;
    })}
  </div>
</div>
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

| 外部项目能力 | Token Bank 原生实现 | 集成方式 |
|------------|-------------------|---------|
| aweskill Skill 管理 | Resource 系统 | 吸收数据模型和投射机制 |
| aweskill 发现/更新 | ResourceDiscovery | 复用 API，原生界面 |
| AionUi Office | OfficeTools | 原生工具链 |
| AionUi Assistant | Assistant 资源 | 原生配置格式 |
| AionUi Agent 引擎 | AgentExecutor | 吸收架构设计 |

**注**：aweswitch 的 Profile 快速切换能力暂不实施

---

## 📋 实施计划（暂不包含 Profile 系统）

### Phase 1：资源管理基础

**1. 数据模型**
- [ ] 设计并创建 resources 相关表
- [ ] 实现 ResourceManager 基础 CRUD
- [ ] 支持 Prompt 和 Skill 类型

**2. 资源发现**
- [ ] 实现 ResourceDiscovery（本地 + sciskill）
- [ ] 资源导入和内容解析
- [ ] 哈希去重机制

**3. 投射机制**
- [ ] 实现 ResourceProjector
- [ ] 支持 symlink/copy 投射
- [ ] 投射状态检查和修复

### Phase 2：界面实现

**4. Resources 页面**
- [ ] 资源列表和搜索
- [ ] 资源详情和编辑
- [ ] 导入和创建

**5. 集成到 Gateway**
- [ ] Agent 卡片显示投射的资源
- [ ] 快速投射/取消投射
- [ ] 状态警告和修复

### Phase 3：Agent 增强

**6. Assistant 系统**
- [ ] Assistant 资源类型
- [ ] 与 Skill/Prompt 关联
- [ ] Debug 页面 Assistant 选择

**7. Office 能力**
- [ ] OfficeTools 基础实现
- [ ] PPT/Word/Excel 生成
- [ ] 文件预览集成

**8. 执行跟踪**
- [ ] agent_tasks 表和逻辑
- [ ] 步骤和工具调用记录
- [ ] 成本统计集成

### Phase 4：测试优化

**9. 测试和完善**
- [ ] 端到端测试
- [ ] 性能优化
- [ ] 文档完善

**注**：Profile 系统（快速切换供给源配置）暂不实施，待后续评估

---

## 🎯 核心价值

### 与外部项目的区别

| 维度 | 外部项目 | Token Bank 原生方案 |
|-----|---------|-------------------|
| **交互方式** | CLI 命令行 | 统一的 GUI |
| **数据存储** | 文件系统 + YAML | SQLite 关系数据库 |
| **用户体验** | 多个工具切换 | 一个平台搞定 |
| **数据模型** | 各自独立 | 统一资源模型 |
| **集成深度** | 外部调用 | 原生集成 |
| **成本追踪** | 无 | 全程追踪 |

### 用户收益

- ✅ **统一体验**：不需要学习多个 CLI 工具
- ✅ **数据打通**：资源、配置、成本全关联
- ✅ **更强大**：在吸收外部能力基础上，增加 Token Bank 独有价值
- ✅ **可扩展**：原生架构易于后续功能扩展

---

_融合方案版本：v1.0 | 2026-07-05_
