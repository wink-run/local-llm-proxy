# Token Bank vs MCPMate：MCP 架构对比

> 明确 Token Bank 的 MCP 实现与 MCPMate 的差异

---

## 🔍 MCPMate 架构分析

### MCPMate 的完整架构

```
┌─────────────────────────────────────────────────────┐
│  MCPMate                                             │
│                                                     │
│  Layer 1: AI Client                                 │
│  ┌───────────────────────────────────────────────┐ │
│  │ Claude Desktop (stdio)                        │ │
│  │ Cursor (stdio)                                │ │
│  │ Zed (stdio)                                   │ │
│  └────────────┬──────────────────────────────────┘ │
│               ↓ stdio protocol                     │
│                                                     │
│  Layer 2: Bridge（协议转换）                        │
│  ┌───────────────────────────────────────────────┐ │
│  │ MCPMate Bridge                                │ │
│  │ - stdio → HTTP 转换                           │ │
│  │ - 独立的 Rust 二进制                          │ │
│  └────────────┬──────────────────────────────────┘ │
│               ↓ HTTP                               │
│                                                     │
│  Layer 3: Proxy（MCP 代理核心）                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ MCPMate Proxy Server                          │ │
│  │ - 聚合多个 MCP Server                         │ │
│  │ - Profile Engine（工具裁剪）                  │ │
│  │ - Runtime Manager（多运行时支持）             │ │
│  │ - 日志和监控                                  │ │
│  └────────────┬──────────────────────────────────┘ │
│               ↓ 调用                               │
│                                                     │
│  Layer 4: MCP Servers（实际工具提供者）             │
│  ┌───────────────────────────────────────────────┐ │
│  │ Filesystem MCP (stdio/HTTP)                   │ │
│  │ GitHub MCP (HTTP)                             │ │
│  │ Database MCP (stdio)                          │ │
│  │ Custom MCP (...)                              │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### MCPMate 的核心价值

**1. MCP 代理聚合**
- 一个代理连接多个 MCP 服务器
- 统一的 HTTP 接口（Streamable HTTP）
- 兼容 stdio 和 SSE 旧协议

**2. Bridge 适配**
- 将 stdio-only 客户端（Claude Desktop）适配到 HTTP 代理
- 无需修改客户端配置格式

**3. Profile 引擎**
- 场景 Profile：基于工作流过滤工具
- 应用 Profile：基于客户端定制
- 动态 Profile：运行时调整

**4. 统一配置**
- 配置一次，所有客户端共享
- 支持 Transparent、Hosted、Unify 三种模式

---

## 🏗️ Token Bank MCP 架构

### 方案 A：完全吸收（类 MCPMate）

**与 MCPMate 相同的架构**，但集成到 Token Bank：

```
┌─────────────────────────────────────────────────────┐
│  Token Bank                                          │
│                                                     │
│  Layer 1: AI Client                                 │
│  ┌───────────────────────────────────────────────┐ │
│  │ Claude Desktop / Codex / Cursor               │ │
│  └────────────┬──────────────────────────────────┘ │
│               ↓ stdio                              │
│                                                     │
│  Layer 2: Token Bank MCP Bridge                    │
│  ┌───────────────────────────────────────────────┐ │
│  │ tokenbank-mcp-bridge (Electron/Node.js)       │ │
│  │ - stdio → 内部 IPC                            │ │
│  └────────────┬──────────────────────────────────┘ │
│               ↓ IPC                                │
│                                                     │
│  Layer 3: Token Bank MCP Manager                   │
│  ┌───────────────────────────────────────────────┐ │
│  │ MCPManager (Electron Main Process)            │ │
│  │ - 聚合多个 MCP Server                         │ │
│  │ - Profile 过滤                                │ │
│  │ - 日志和成本追踪                              │ │
│  │ - Providers UI 管理                           │ │
│  └────────────┬──────────────────────────────────┘ │
│               ↓ 调用                               │
│                                                     │
│  Layer 4: MCP Servers                              │
│  ┌───────────────────────────────────────────────┐ │
│  │ 各类 MCP Server                                │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**优势**：
- ✅ 完整的 MCP 代理能力
- ✅ 统一配置管理
- ✅ 与 Token Bank 深度集成

**劣势**：
- ❌ 架构复杂，需要实现 Bridge
- ❌ 与 MCPMate 重复造轮子

---

### 方案 B：轻量级代理（推荐）

**只做管理和简单代理**，复杂的代理逻辑让 MCPMate 去做：

```
┌─────────────────────────────────────────────────────┐
│  Token Bank MCP 管理                                 │
│                                                     │
│  Providers UI (MCP 管理界面)                        │
│  ┌───────────────────────────────────────────────┐ │
│  │ - 添加/编辑/删除 MCP Server                   │ │
│  │ - Profile 管理                                │ │
│  │ - 客户端绑定                                  │ │
│  │ - 日志和监控                                  │ │
│  └────────────┬──────────────────────────────────┘ │
│               ↓ 管理数据                           │
│                                                     │
│  MCP Manager (Electron)                            │
│  ┌───────────────────────────────────────────────┐ │
│  │ - 数据管理（SQLite）                          │ │
│  │ - 配置生成                                    │ │
│  │ - 日志收集                                    │ │
│  │ - 成本追踪                                    │ │
│  └────────────┬──────────────────────────────────┘ │
│               ↓ 生成配置                           │
│                                                     │
│  配置输出                                           │
│  ┌───────────────────────────────────────────────┐ │
│  │ Option 1: 生成 MCPMate 配置                   │ │
│  │ Option 2: 直接配置到 Agent (stdio-proxy)      │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
                ↓
        ┌───────┴─────────┐
        │                 │
   MCPMate (可选)    Agent 直接调用
```

**核心思想**：
- Token Bank **管理** MCP Server（数据、配置、监控）
- 实际代理可以用 MCPMate 或直接调用
- 不重复造轮子，聚焦管理和集成

**实现方式**：

**1. 与 MCPMate 协同**

```javascript
// Token Bank 生成 MCPMate 配置
export class MCPMateIntegration {
  /**
   * 导出到 MCPMate 配置格式
   */
  static async exportToMCPMate() {
    const servers = await db.all('SELECT * FROM mcp_servers WHERE status = "active"');
    
    // 生成 MCPMate 配置
    const mcpmateConfig = {
      servers: servers.map(s => ({
        id: s.id,
        name: s.name,
        type: s.type,
        command: s.command,
        args: JSON.parse(s.args || '[]'),
        env: JSON.parse(s.env || '{}')
      })),
      profiles: await this.exportProfiles(),
      clients: await this.exportClients()
    };
    
    // 写入 MCPMate 配置文件
    const mcpmateConfigPath = path.join(os.homedir(), '.mcpmate', 'config.json');
    await fs.writeFile(mcpmateConfigPath, JSON.stringify(mcpmateConfig, null, 2));
    
    return { success: true, configPath: mcpmateConfigPath };
  }
}
```

**2. 或者轻量级 stdio 代理**

```javascript
// tokenbank-mcp-proxy (简化版)
// 只负责转发，不做复杂逻辑

import { MCPManager } from './mcp-manager.js';

const manager = new MCPManager(db);
const serverName = process.argv[2];

const server = await manager.getServerByName(serverName);

// 直接启动 MCP Server 进程，转发 stdio
const proc = spawn(server.command, JSON.parse(server.args), {
  env: { ...process.env, ...JSON.parse(server.env) }
});

// 透传 stdin/stdout
process.stdin.pipe(proc.stdin);
proc.stdout.pipe(process.stdout);

// 记录日志（异步，不阻塞）
proc.stdout.on('data', (data) => {
  manager.logMCPCall(serverName, data.toString()).catch(() => {});
});
```

---

## 📊 方案对比

| 维度 | MCPMate | Token Bank 方案 A | Token Bank 方案 B |
|-----|---------|------------------|------------------|
| **定位** | 独立 MCP 代理应用 | MCP 代理集成到 TB | MCP 管理 + 可选代理 |
| **Bridge** | ✅ 完整实现 | ✅ 需实现 | ❌ 简化或复用 MCPMate |
| **代理层** | ✅ Rust 高性能 | ✅ Node.js | ✅ 可选（MCPMate/简化版） |
| **Profile** | ✅ 完整引擎 | ✅ 需实现 | ✅ 数据管理 + 配置生成 |
| **管理 UI** | ✅ React Dashboard | ✅ 集成到 Providers | ✅ 集成到 Providers |
| **成本追踪** | ❌ | ✅ | ✅ |
| **实现复杂度** | 高（独立应用） | 高（完整代理） | **低（管理为主）** |
| **与 TB 集成** | ❌ 独立 | ✅ 原生 | ✅ 原生 |

---

## 🎯 推荐方案：B（轻量级）

**核心思路**：

**Token Bank 聚焦于"管理"，而非"代理"**

1. **数据管理**
   - 在 SQLite 中管理 MCP Server 配置
   - Profile 规则存储
   - 客户端绑定关系

2. **UI 管理**
   - Providers 页面统一管理 Model + MCP
   - 添加/编辑/删除 MCP Server
   - Profile 可视化编辑

3. **配置生成**
   - 生成标准的 MCP 配置（Claude Desktop 格式）
   - 或生成 MCPMate 配置（如果用户已安装）
   - 或提供轻量级 stdio 代理

4. **日志和监控**
   - 收集 MCP 调用日志
   - 关联到 local_stats（成本追踪）
   - 可视化展示

**与 MCPMate 的关系**：

```
Token Bank:
  - 管理 MCP Server 数据
  - 提供 UI 界面
  - 成本追踪和统计
  - 配置生成

MCPMate (可选):
  - 实际的代理层
  - 高性能转发
  - Bridge 适配

用户选择：
  Option 1: Token Bank 管理 + MCPMate 代理（推荐）
  Option 2: Token Bank 管理 + 简化代理（轻量）
  Option 3: Token Bank 管理 + Agent 直接调用（最简）
```

**实施步骤**：

1. **Phase 1**：数据模型和管理
   - mcp_servers / mcp_profiles 表
   - MCPManager 基础实现
   - Providers 页面 MCP 管理

2. **Phase 2**：配置生成
   - 生成标准 MCP 配置
   - MCPMate 配置导出
   - 简化 stdio 代理（可选）

3. **Phase 3**：监控集成
   - 日志收集
   - 成本追踪
   - 可视化展示

---

## 💡 核心优势

**不与 MCPMate 竞争，而是互补**：

- ✅ Token Bank：管理和集成层
- ✅ MCPMate：代理和转发层
- ✅ 用户可选择组合使用
- ✅ 避免重复造轮子

**Token Bank 的独特价值**：

- ✅ 与 Model Provider 统一管理（双维度供给源）
- ✅ 成本追踪（MCP 调用纳入 Token Bank 成本体系）
- ✅ Agent 聚合（MCP 工具注入到 Agent 执行）
- ✅ 统一 UI（不需要单独打开 MCPMate Dashboard）

---

_MCP 架构对比版本：v1.0 | 2026-07-05_
