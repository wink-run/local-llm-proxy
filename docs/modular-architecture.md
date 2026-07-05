# Token Bank 模块化架构说明

> Token Bank 的各模块可独立使用，灵活组合

---

## 📦 模块化设计

### 核心理念

**Token Bank 不是一个必须全盘接受的系统，而是可按需选择的模块组合**

```
┌─────────────────────────────────────────────────────┐
│  Token Bank 模块                                     │
│                                                     │
│  📦 模块 1：网关代理（可选）                         │
│     功能：代理模型请求，成本追踪，智能路由           │
│     使用：Agent 配置 Token Bank 作为 API 端点        │
│                                                     │
│  📦 模块 2：资源管理（独立）                         │
│     功能：MCP Server、Skill、Prompt 统一管理         │
│     使用：Agent 直连官方 API，但使用 TB 的资源       │
│                                                     │
│  📦 模块 3：Agent 聚合（可选）                       │
│     功能：Debug 页面统一调用多个 Agent               │
│     使用：跨 Agent 场景，或需要统一界面时            │
└─────────────────────────────────────────────────────┘
```

---

## 🎯 四种使用模式

### 模式 A：完全独立

```
用户 → Agent (Claude Desktop)
        ↓ 直连
      官方 API (Anthropic)

✅ 适合：对 Token Bank 不感兴趣
❌ 缺失：成本追踪、资源管理
```

### 模式 B：仅使用网关

```
用户 → Agent (Claude Desktop)
        ↓ 通过网关
      Token Bank Gateway
        ↓ 代理
      官方 API (Anthropic)

✅ 获得：成本追踪、智能路由、P2P
❌ 未用：资源管理、Agent 聚合
```

### 模式 C：仅使用资源（重点）

```
用户 → Agent (Claude Desktop)
        ↓ 直连
      官方 API (Anthropic)
        +
      Token Bank 资源
        ├─ MCP Server (Token Bank 提供)
        └─ Skill (Token Bank 投射)

✅ 获得：MCP 统一管理、Skill 投射、资源共享
✅ 保持：直连官方，无代理
❌ 缺失：成本追踪（因为不走网关）
```

**模式 C 的典型场景**：

```
Claude Desktop 配置：
  1. API 配置：直连 Anthropic 官方
     {
       "anthropic": {
         "api_key": "sk-ant-xxx"  // 官方 API Key
       }
     }
  
  2. MCP 配置：使用 Token Bank 的 MCP
     {
       "mcpServers": {
         "filesystem": {
           "command": "tokenbank-mcp-proxy",
           "args": ["filesystem"]  // Token Bank 提供的 MCP
         },
         "github": {
           "command": "tokenbank-mcp-proxy",
           "args": ["github"]
         }
       }
     }
  
  3. Skill 配置：使用 Token Bank 投射的 Skill
     ~/.config/claude-code/skills/
       ├─ python-data-science/  (Token Bank 投射)
       ├─ react-development/    (Token Bank 投射)
       └─ ...

结果：
  - Claude Desktop 推理走官方 API（Token Bank 不参与）
  - MCP 工具由 Token Bank 统一管理
  - Skill 由 Token Bank 统一管理和投射
```

### 模式 D：全部使用

```
用户 → Token Bank Debug 页面
        ↓ 聚合调用
      Agent (Claude Code/Codex/...)
        ↓ 通过网关
      Token Bank Gateway
        ↓ 代理
      官方 API (Anthropic)
        +
      Token Bank 资源
        ├─ MCP Server
        ├─ Skill
        └─ Prompt

✅ 获得：所有功能
  - 成本追踪
  - 资源管理
  - 统一界面
  - 跨 Agent 协同
```

---

## 🔧 技术实现：模式 C（独立资源管理）

### 1. Token Bank MCP Proxy

**Token Bank 提供一个轻量级的 MCP 代理**，Agent 可以通过它使用 Token Bank 管理的 MCP Server：

```javascript
// client/electron/mcp-proxy-cli.js
// 作为独立的 CLI 工具，供 Agent 调用

import { MCPManager } from './mcp-manager.js';

const manager = new MCPManager(db);

// 从命令行参数获取要代理的 MCP Server
const serverName = process.argv[2];  // 如 'filesystem'

// 启动 stdio 代理
const server = await manager.getServerByName(serverName);
await manager.startServer(server.id);

// 转发 stdin/stdout
process.stdin.on('data', async (data) => {
  // 解析 MCP 请求
  const request = JSON.parse(data);
  
  // 调用实际的 MCP Server
  const result = await manager.callTool(
    server.id,
    request.params.name,
    request.params.arguments
  );
  
  // 返回结果
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result
  }) + '\n');
});
```

**Agent 配置**：

```json
// Claude Desktop config.json
{
  "mcpServers": {
    "filesystem": {
      "command": "/path/to/tokenbank-mcp-proxy",
      "args": ["filesystem"]
    },
    "github": {
      "command": "/path/to/tokenbank-mcp-proxy",
      "args": ["github"]
    }
  }
}
```

### 2. Skill 投射机制

**Token Bank 将 Skill 投射到 Agent 的配置目录**（symlink/copy）：

```javascript
// client/electron/resource-projector.js

export class ResourceProjector {
  /**
   * 投射 Skill 到 Agent（不依赖网关）
   */
  static async project(resourceId, agentId, scope = 'global') {
    const resource = await db.get('SELECT * FROM resources WHERE id = ?', resourceId);
    const agentConfig = AGENT_CONFIGS[agentId];  // Claude Code、Codex 等配置
    
    // 确定目标路径（从 Agent 文档获取）
    const targetPath = scope === 'global' 
      ? agentConfig.globalSkillPath   // 如 ~/.config/claude-code/skills/
      : path.join(scope, agentConfig.projectSkillPath);
    
    // 创建 SKILL.md
    const skillDir = path.join(targetPath, resource.name);
    await fs.ensureDir(skillDir);
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      resource.content,
      'utf8'
    );
    
    // 记录投射关系
    await db.run(`
      INSERT INTO resource_projections 
      (id, resource_id, agent_id, scope, target_path, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `, [nanoid(), resourceId, agentId, scope, skillDir]);
  }
}
```

### 3. 用户工作流（模式 C）

**步骤 1：在 Token Bank 中管理资源**

```
Token Bank UI:
  1. Providers 页面 → MCP Server 标签
     - 添加 Filesystem MCP
     - 添加 GitHub MCP
     - 启动服务器

  2. Resources 页面 → Skill 管理
     - 导入 "Python Data Science" Skill
     - 导入 "React Development" Skill
     
  3. Gateway 页面 → 投射管理
     - 投射 Skill 到 Claude Code
     - 投射 Skill 到 Codex
```

**步骤 2：配置 Agent 使用 Token Bank 资源**

```bash
# Claude Desktop 配置
# ~/.config/claude-desktop/config.json

{
  "anthropic": {
    "api_key": "sk-ant-xxx"  # 官方 API，不走 Token Bank 网关
  },
  "mcpServers": {
    "filesystem": {
      "command": "tokenbank-mcp-proxy",
      "args": ["filesystem"]  # Token Bank 提供
    }
  }
}

# Skill 已自动投射到 ~/.config/claude-code/skills/
```

**步骤 3：正常使用 Agent**

```bash
# 用户在 Claude Desktop 中操作
# - 推理请求：直连 Anthropic 官方 API
# - MCP 工具：通过 Token Bank 的 MCP Proxy
# - Skill：使用 Token Bank 投射的 Skill

# Token Bank 不参与推理，只提供资源
```

---

## 📊 模式对比

| 维度 | 模式 A | 模式 B | 模式 C | 模式 D |
|-----|-------|-------|-------|-------|
| **网关代理** | ❌ | ✅ | ❌ | ✅ |
| **成本追踪** | ❌ | ✅ | ❌ | ✅ |
| **MCP 管理** | ❌ | ❌ | ✅ | ✅ |
| **Skill 管理** | ❌ | ❌ | ✅ | ✅ |
| **Agent 聚合** | ❌ | ❌ | ❌ | ✅ |
| **推理路径** | 官方 | 网关 | 官方 | 网关 |
| **适用场景** | 完全独立 | 只要成本追踪 | 只要资源管理 | 全功能使用 |

---

## 🎯 核心价值

**Token Bank 的模块化设计，让用户可以：**

1. **灵活选择**：不是"全有或全无"，而是"按需组合"
2. **低门槛**：可以先只用资源管理（不改变推理路径）
3. **渐进式**：从模式 C → 模式 B → 模式 D 逐步升级
4. **非绑定**：资源管理不依赖网关，可独立运行

**特别适合**：

- 已有官方 API Key，不想改变推理路径的用户
- 只想统一管理 MCP 和 Skill 的团队
- 需要跨 Agent 资源共享的场景

---

_模块化架构版本：v1.0 | 2026-07-05_
