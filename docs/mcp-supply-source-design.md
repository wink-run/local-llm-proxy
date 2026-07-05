# MCP 作为供给源的设计方案

> 吸收 MCPMate 的设计精华，将 MCP 作为 Token Bank 供给源的第二个维度

---

## 🎯 核心理念

### 供给源的双维度

```
传统 Token Bank：
  供给源 = Model Provider（模型提供商）
    ├─ Anthropic (Claude)
    ├─ OpenAI (GPT)
    ├─ Google (Gemini)
    └─ ...

增强后的 Token Bank：
  供给源 = Model Provider + MCP Server
  
  维度 1：Model Provider（提供推理能力）
    ├─ Anthropic
    ├─ OpenAI
    └─ ...
  
  维度 2：MCP Server（提供工具和上下文）
    ├─ Filesystem MCP（文件操作）
    ├─ GitHub MCP（代码托管）
    ├─ Database MCP（数据库访问）
    ├─ Web Search MCP（网络搜索）
    └─ Custom MCP（自定义工具）
```

### MCPMate 的核心价值

**吸收的亮点**：

1. **MCP 代理**：在 AI 客户端和 MCP 服务器之间做透明代理
2. **统一配置**：一次配置 MCP 服务器，多个客户端共享
3. **Profile 裁剪**：基于场景动态裁剪工具，减少 token 消耗
4. **实时监控**：日志、安全检测、资源管理
5. **Bridge 适配**：stdio ↔ HTTP 转换

**Token Bank 原生实现**：

- ❌ 不做独立的 MCP 代理应用
- ✅ 将 MCP 管理集成到 Token Bank 供给源体系
- ✅ 在 Providers 页面统一管理 Model + MCP
- ✅ Profile 机制融合到场景路由
- ✅ MCP 工具纳入资源管理系统

---

## 📦 一、数据模型

### 1.1 MCP Server 管理

```sql
-- MCP 服务器注册表
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  type TEXT NOT NULL,        -- 'stdio' | 'http' | 'sse'
  command TEXT,              -- stdio: 执行命令
  args TEXT,                 -- JSON: 命令参数
  url TEXT,                  -- http/sse: 服务地址
  env TEXT,                  -- JSON: 环境变量
  status TEXT NOT NULL,      -- 'active' | 'inactive' | 'error'
  capabilities TEXT,         -- JSON: 提供的工具列表
  metadata TEXT,             -- JSON: 版本、描述等
  created_at INTEGER,
  updated_at INTEGER
);

-- MCP 工具能力
CREATE TABLE mcp_capabilities (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id),
  name TEXT NOT NULL,        -- 工具名称
  description TEXT,
  input_schema TEXT,         -- JSON Schema
  category TEXT,             -- 'filesystem' | 'web' | 'database' | 'code' 等
  cost_estimate TEXT,        -- 预估成本（某些 MCP 可能收费）
  enabled INTEGER DEFAULT 1,
  UNIQUE(server_id, name)
);

-- MCP Profile（场景化工具裁剪）
CREATE TABLE mcp_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  description TEXT,
  rules TEXT NOT NULL,       -- JSON: 裁剪规则
  created_at INTEGER
);

-- Profile 规则示例：
-- {
--   "include": ["filesystem.*", "github.read_*"],
--   "exclude": ["filesystem.delete_*"],
--   "client_overrides": {
--     "claude-desktop": { "include": ["*"] },
--     "cursor": { "exclude": ["web.*"] }
--   }
-- }

-- MCP 客户端绑定（哪些 Agent 使用哪些 MCP）
CREATE TABLE mcp_client_bindings (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,   -- 'claude-desktop' | 'codex' | 'cursor' 等
  server_id TEXT NOT NULL REFERENCES mcp_servers(id),
  profile_id TEXT REFERENCES mcp_profiles(id),
  enabled INTEGER DEFAULT 1,
  UNIQUE(client_id, server_id)
);

-- MCP 调用日志
CREATE TABLE mcp_call_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  agent_id TEXT,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id),
  capability_name TEXT NOT NULL,
  input TEXT,                -- JSON: 输入参数
  output TEXT,               -- JSON: 输出结果
  status TEXT,               -- 'success' | 'error'
  error TEXT,
  duration_ms INTEGER,
  timestamp INTEGER
);

-- MCP 使用统计（扩展 local_stats）
ALTER TABLE local_stats ADD COLUMN mcp_server_id TEXT;
ALTER TABLE local_stats ADD COLUMN mcp_capability TEXT;
```

---

## 🔀 二、MCP 管理器

### 2.1 MCP Server Manager

```javascript
// client/electron/mcp-manager.js
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export class MCPManager extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.runningServers = new Map(); // serverId → process
    this.httpClients = new Map();     // serverId → HTTP client
  }

  /**
   * 启动 MCP 服务器
   */
  async startServer(serverId) {
    const server = await this.db.get(
      'SELECT * FROM mcp_servers WHERE id = ?',
      serverId
    );

    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }

    if (server.type === 'stdio') {
      return await this.startStdioServer(server);
    } else if (server.type === 'http') {
      return await this.connectHttpServer(server);
    }

    throw new Error(`Unsupported MCP type: ${server.type}`);
  }

  /**
   * 启动 stdio 模式的 MCP 服务器
   */
  async startStdioServer(server) {
    const args = JSON.parse(server.args || '[]');
    const env = { ...process.env, ...JSON.parse(server.env || '{}') };

    const proc = spawn(server.command, args, { env });

    let initData = '';

    // 等待服务器就绪
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('MCP server startup timeout'));
      }, 10000);

      proc.stdout.on('data', async (data) => {
        initData += data.toString();
        
        // 解析初始化响应（MCP 协议）
        try {
          const lines = initData.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            
            const msg = JSON.parse(line);
            if (msg.method === 'tools/list' || msg.result?.tools) {
              clearTimeout(timeout);
              
              // 更新能力列表
              await this.updateCapabilities(server.id, msg.result?.tools || []);
              
              // 保存进程引用
              this.runningServers.set(server.id, proc);
              
              resolve({ success: true, serverId: server.id });
            }
          }
        } catch {}
      });

      proc.stderr.on('data', (data) => {
        console.error(`[MCP:${server.id}]`, data.toString());
      });

      proc.on('close', (code) => {
        this.runningServers.delete(server.id);
        this.emit('server:stopped', { serverId: server.id, code });
      });
    });
  }

  /**
   * 连接 HTTP 模式的 MCP 服务器
   */
  async connectHttpServer(server) {
    // HTTP/SSE 模式直接连接
    const client = {
      url: server.url,
      type: server.type
    };

    // 获取能力列表
    const capabilities = await this.fetchHttpCapabilities(server.url);
    await this.updateCapabilities(server.id, capabilities);

    this.httpClients.set(server.id, client);

    return { success: true, serverId: server.id };
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(serverId, toolName, args) {
    const server = await this.db.get(
      'SELECT * FROM mcp_servers WHERE id = ?',
      serverId
    );

    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }

    const startTime = Date.now();

    try {
      let result;

      if (server.type === 'stdio') {
        result = await this.callStdioTool(serverId, toolName, args);
      } else {
        result = await this.callHttpTool(serverId, toolName, args);
      }

      const duration = Date.now() - startTime;

      // 记录日志
      await this.logCall(serverId, toolName, args, result, duration, 'success');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // 记录错误
      await this.logCall(serverId, toolName, args, null, duration, 'error', error.message);
      
      throw error;
    }
  }

  /**
   * 调用 stdio 工具
   */
  async callStdioTool(serverId, toolName, args) {
    const proc = this.runningServers.get(serverId);
    
    if (!proc) {
      throw new Error(`MCP server not running: ${serverId}`);
    }

    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2);
      const request = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      };

      let responseData = '';

      const dataHandler = (data) => {
        responseData += data.toString();
        
        try {
          const lines = responseData.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            
            const msg = JSON.parse(line);
            if (msg.id === requestId) {
              proc.stdout.off('data', dataHandler);
              
              if (msg.error) {
                reject(new Error(msg.error.message));
              } else {
                resolve(msg.result);
              }
            }
          }
        } catch {}
      };

      proc.stdout.on('data', dataHandler);

      // 发送请求
      proc.stdin.write(JSON.stringify(request) + '\n');

      // 超时处理
      setTimeout(() => {
        proc.stdout.off('data', dataHandler);
        reject(new Error('MCP call timeout'));
      }, 30000);
    });
  }

  /**
   * 调用 HTTP 工具
   */
  async callHttpTool(serverId, toolName, args) {
    const client = this.httpClients.get(serverId);
    
    if (!client) {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    const response = await fetch(`${client.url}/tools/${toolName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: args })
    });

    if (!response.ok) {
      throw new Error(`MCP call failed: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * 更新能力列表
   */
  async updateCapabilities(serverId, tools) {
    // 清空旧能力
    await this.db.run('DELETE FROM mcp_capabilities WHERE server_id = ?', serverId);

    // 插入新能力
    for (const tool of tools) {
      await this.db.run(`
        INSERT INTO mcp_capabilities 
        (id, server_id, name, description, input_schema, category)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        `${serverId}_${tool.name}`,
        serverId,
        tool.name,
        tool.description,
        JSON.stringify(tool.inputSchema || {}),
        this.inferCategory(tool.name)
      ]);
    }
  }

  /**
   * 推断工具分类
   */
  inferCategory(toolName) {
    if (/file|read|write|ls|dir/i.test(toolName)) return 'filesystem';
    if (/git|github|gitlab/i.test(toolName)) return 'code';
    if (/search|web|http/i.test(toolName)) return 'web';
    if (/sql|db|query/i.test(toolName)) return 'database';
    return 'other';
  }

  /**
   * 记录调用日志
   */
  async logCall(serverId, toolName, input, output, duration, status, error = null) {
    await this.db.run(`
      INSERT INTO mcp_call_logs
      (id, server_id, capability_name, input, output, status, error, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `log_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      serverId,
      toolName,
      JSON.stringify(input),
      JSON.stringify(output),
      status,
      error,
      duration,
      Date.now()
    ]);
  }

  /**
   * 获取 Profile 过滤后的工具列表
   */
  async getFilteredCapabilities(clientId, profileId) {
    // 获取客户端绑定的 MCP 服务器
    const bindings = await this.db.all(`
      SELECT * FROM mcp_client_bindings 
      WHERE client_id = ? AND enabled = 1
    `, clientId);

    // 获取所有可用工具
    const allCapabilities = [];
    for (const binding of bindings) {
      const caps = await this.db.all(`
        SELECT * FROM mcp_capabilities 
        WHERE server_id = ? AND enabled = 1
      `, binding.server_id);
      allCapabilities.push(...caps);
    }

    // 应用 Profile 过滤
    if (profileId) {
      const profile = await this.db.get(
        'SELECT * FROM mcp_profiles WHERE id = ?',
        profileId
      );
      
      if (profile) {
        return this.applyProfileRules(allCapabilities, JSON.parse(profile.rules), clientId);
      }
    }

    return allCapabilities;
  }

  /**
   * 应用 Profile 规则
   */
  applyProfileRules(capabilities, rules, clientId) {
    let filtered = capabilities;

    // 客户端特定规则
    const clientRules = rules.client_overrides?.[clientId];
    const activeRules = clientRules || rules;

    // Include 规则
    if (activeRules.include) {
      filtered = filtered.filter(cap => 
        activeRules.include.some(pattern => 
          this.matchPattern(cap.name, pattern)
        )
      );
    }

    // Exclude 规则
    if (activeRules.exclude) {
      filtered = filtered.filter(cap => 
        !activeRules.exclude.some(pattern => 
          this.matchPattern(cap.name, pattern)
        )
      );
    }

    return filtered;
  }

  /**
   * 匹配通配符模式
   */
  matchPattern(name, pattern) {
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );
    return regex.test(name);
  }

  /**
   * 停止 MCP 服务器
   */
  async stopServer(serverId) {
    const proc = this.runningServers.get(serverId);
    if (proc) {
      proc.kill('SIGTERM');
      this.runningServers.delete(serverId);
    }

    this.httpClients.delete(serverId);

    await this.db.run(
      'UPDATE mcp_servers SET status = ? WHERE id = ?',
      ['inactive', serverId]
    );
  }

  /**
   * 停止所有 MCP 服务器
   */
  async stopAll() {
    for (const [serverId] of this.runningServers) {
      await this.stopServer(serverId);
    }
  }
}
```

---

## 🎨 三、Providers 页面集成

### 3.1 UI 设计

```
┌────────────────────────────────────────────────────────┐
│  供给源管理                                             │
├────────────────────────────────────────────────────────┤
│  [Model Provider] [MCP Server] [Route] [Stats]        │
├────────────────────────────────────────────────────────┤
│                                                        │
│  MCP 服务器 (5)                    [➕ 添加 MCP Server] │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 🔧 Filesystem MCP        [stdio]     ✅ 运行中    │ │
│  │    提供文件系统操作能力                            │ │
│  │    工具: read_file, write_file, list_directory   │ │
│  │    绑定: claude-desktop, codex, cursor           │ │
│  │    [配置] [停止] [查看日志]                       │ │
│  ├──────────────────────────────────────────────────┤ │
│  │ 🐙 GitHub MCP            [http]      ✅ 运行中    │ │
│  │    GitHub 仓库和 Issue 管理                       │ │
│  │    工具: search_repos, create_issue, get_pr      │ │
│  │    绑定: claude-desktop                          │ │
│  │    [配置] [停止] [查看日志]                       │ │
│  ├──────────────────────────────────────────────────┤ │
│  │ 🗄️  Database MCP          [stdio]     ⚪ 已停止   │ │
│  │    数据库查询和管理                               │ │
│  │    工具: query, list_tables, insert              │ │
│  │    绑定: 未绑定                                   │ │
│  │    [启动] [配置] [删除]                           │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  MCP Profile (3)                        [➕ 新建 Profile]│
│  ┌──────────────────────────────────────────────────┐ │
│  │ 📋 Development Mode                              │ │
│  │    开发场景：包含所有文件和代码相关工具            │ │
│  │    规则: include [filesystem.*, github.*]       │ │
│  │    应用: claude-desktop, cursor                  │ │
│  │    [编辑] [删除]                                  │ │
│  ├──────────────────────────────────────────────────┤ │
│  │ 📋 Safe Mode                                     │ │
│  │    安全模式：只读操作，禁止删除和修改             │ │
│  │    规则: exclude [*.delete_*, *.write_*]        │ │
│  │    应用: 无                                       │ │
│  │    [编辑] [激活] [删除]                           │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  客户端绑定                                             │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Claude Desktop                                   │ │
│  │   ✅ Filesystem MCP  (Development Mode)          │ │
│  │   ✅ GitHub MCP      (Development Mode)          │ │
│  │   [管理绑定]                                      │ │
│  ├──────────────────────────────────────────────────┤ │
│  │ Codex Desktop                                    │ │
│  │   ✅ Filesystem MCP  (无 Profile)                │ │
│  │   [管理绑定]                                      │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

### 3.2 添加 MCP Server 对话框

```jsx
function AddMCPServerModal({ onClose, onSave }) {
  const [type, setType] = useState('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');

  return (
    <div className="modal">
      <h2>添加 MCP Server</h2>
      
      <div className="form-group">
        <label>类型:</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="stdio">stdio（本地进程）</option>
          <option value="http">HTTP（远程服务）</option>
        </select>
      </div>

      <div className="form-group">
        <label>名称:</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如: filesystem-mcp"
        />
      </div>

      {type === 'stdio' && (
        <>
          <div className="form-group">
            <label>命令:</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="如: npx @modelcontextprotocol/server-filesystem"
            />
          </div>
          
          <div className="form-group">
            <label>参数 (JSON 数组):</label>
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder='如: ["/Users/me/projects"]'
            />
          </div>
        </>
      )}

      {type === 'http' && (
        <div className="form-group">
          <label>URL:</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="如: http://localhost:3000/mcp"
          />
        </div>
      )}

      <div className="actions">
        <button onClick={onClose}>取消</button>
        <button onClick={() => handleSave()}>保存并启动</button>
      </div>
    </div>
  );
}
```

---

## 🔗 四、与 Agent 聚合的联动

### 4.1 Agent 调用时注入 MCP 工具

```javascript
// client/electron/agent-executor.js (扩展)

export class AgentExecutor extends EventEmitter {
  async execute(agentId, prompt, options = {}) {
    // ... 现有逻辑 ...

    // 获取该 Agent 可用的 MCP 工具
    const mcpCapabilities = await this.mcpManager.getFilteredCapabilities(
      agentId,
      options.mcpProfile || null
    );

    // 将 MCP 工具注入到 Agent 上下文
    const enhancedOptions = {
      ...options,
      tools: [
        ...(options.tools || []),
        ...mcpCapabilities.map(cap => ({
          name: cap.name,
          description: cap.description,
          input_schema: JSON.parse(cap.input_schema),
          __mcp_server: cap.server_id
        }))
      ]
    };

    // 执行 Agent
    const result = await this.executeAgent(agentId, prompt, enhancedOptions);

    return result;
  }

  /**
   * Agent 调用 MCP 工具时的钩子
   */
  async handleToolCall(toolName, args, context) {
    // 检查是否是 MCP 工具
    const tool = context.tools.find(t => t.name === toolName);
    
    if (tool && tool.__mcp_server) {
      // 调用 MCP
      const result = await this.mcpManager.callTool(
        tool.__mcp_server,
        toolName,
        args
      );

      // 记录到 local_stats（关联 MCP）
      await this.recordMCPCost(tool.__mcp_server, toolName, result);

      return result;
    }

    // 非 MCP 工具，走原有逻辑
    return await this.handleNormalToolCall(toolName, args, context);
  }
}
```

### 4.2 Debug 页面显示 MCP 工具

```jsx
// Agent 卡片显示可用的 MCP 工具
function AgentCard({ agent, selected, onClick }) {
  const [mcpTools, setMcpTools] = useState([]);

  useEffect(() => {
    // 加载该 Agent 可用的 MCP 工具
    window.electronAPI.mcp.getCapabilities(agent.id)
      .then(setMcpTools);
  }, [agent.id]);

  return (
    <div className={`agent-card ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="agent-header">
        <span className="icon">🤖</span>
        <span className="name">{agent.name}</span>
        <span className="version">v{agent.version}</span>
      </div>
      
      <div className="agent-capabilities">
        <span>能力: {agent.capabilities.join(', ')}</span>
      </div>

      {mcpTools.length > 0 && (
        <div className="mcp-tools">
          <span className="label">MCP 工具 ({mcpTools.length}):</span>
          <div className="tools-list">
            {mcpTools.slice(0, 5).map(tool => (
              <span key={tool.name} className="tool-badge" title={tool.description}>
                🔧 {tool.name}
              </span>
            ))}
            {mcpTools.length > 5 && (
              <span className="more">+{mcpTools.length - 5} 更多</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## 📋 实施计划

### Phase 1：MCP 基础架构

**1. 数据模型**
- [ ] 创建 mcp_servers / mcp_capabilities / mcp_profiles 表
- [ ] 扩展 local_stats 添加 MCP 字段

**2. MCP Manager**
- [ ] 实现 MCPManager 类
- [ ] 支持 stdio 模式
- [ ] 支持 HTTP 模式
- [ ] 工具调用和日志记录

### Phase 2：Providers 页面集成

**3. MCP 管理界面**
- [ ] MCP Server 标签页
- [ ] 添加/编辑/删除 MCP Server
- [ ] 启动/停止 MCP Server
- [ ] 查看工具列表和日志

**4. Profile 管理**
- [ ] 创建/编辑 MCP Profile
- [ ] 规则编辑器（include/exclude）
- [ ] Profile 应用到客户端

### Phase 3：Agent 联动

**5. Agent + MCP 集成**
- [ ] Agent 执行时注入 MCP 工具
- [ ] MCP 工具调用拦截
- [ ] Debug 页面显示 MCP 工具
- [ ] 成本追踪（关联 MCP）

### Phase 4：高级功能

**6. 优化和扩展**
- [ ] MCP 服务器自动发现
- [ ] 社区 MCP 市场集成
- [ ] MCP 工具使用统计
- [ ] 安全监控和告警

---

## 🎯 核心价值

### 与 MCPMate 的对比

| 维度 | MCPMate | Token Bank 原生方案 |
|-----|---------|-------------------|
| **定位** | 独立 MCP 代理 | 集成到供给源体系 |
| **管理界面** | 独立应用 | Providers 页面统一管理 |
| **与 Agent 集成** | 配置文件 | 原生 IPC 调用 |
| **成本追踪** | 无 | 全程追踪（local_stats） |
| **Profile** | 独立 Profile | 融合到场景路由 |
| **数据存储** | 独立数据库 | 统一 SQLite |

### 用户收益

- ✅ **统一管理**：Model Provider + MCP Server 在一个页面
- ✅ **无缝集成**：Agent 自动获得 MCP 工具，无需手动配置
- ✅ **成本可控**：MCP 调用纳入 Token Bank 成本体系
- ✅ **场景化**：Profile 机制减少不必要的工具暴露，降低 token 消耗
- ✅ **可观测**：实时日志、统计、监控

---

_MCP 供给源设计版本：v1.0 | 2026-07-05_
