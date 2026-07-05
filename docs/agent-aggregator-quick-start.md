# Agent 聚合入口 - 快速实施指南

> 将 Debug 页面升级为统一的 Agent 调用入口

---

## 🎯 目标

将当前的 Debug 页面（仅支持 LLM 调试）升级为 **Agent 聚合入口**，支持：
- 🐛 **LLM 调试**：保留现有功能
- 🤖 **Agent 工作**：调用已纳管的智能体完成实际任务

---

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────┐
│  Debug / Agent 页面                                  │
│  ┌─────────────┐  ┌─────────────┐                  │
│  │  LLM 模式   │  │ Agent 模式  │  ← 模式切换      │
│  │  (现有)     │  │  (新增)     │                  │
│  └──────┬──────┘  └──────┬──────┘                  │
└─────────┼──────────────┼─────────────────────────────┘
          │              │
          ▼              ▼
    ┌──────────┐   ┌────────────────────┐
    │ 直接调用 │   │ Agent Executor     │
    │ LLM API  │   │ ┌────────────────┐ │
    └──────────┘   │ │ AionUi         │ │
                   │ │ Claude Code    │ │
                   │ │ Codex          │ │
                   │ │ Cursor         │ │
                   │ └────────────────┘ │
                   └────────────────────┘
```

---

## 📦 核心组件

### 1. AgentExecutor（Agent 执行引擎）

**位置**：`client/electron/agent-executor.js`

**职责**：
- 统一调用不同类型的 Agent
- 管理 Agent 进程生命周期
- 解析执行事件并转发到前端
- 收集执行结果和统计信息

**关键方法**：
```javascript
class AgentExecutor extends EventEmitter {
  execute(prompt, options)      // 执行任务
  stop()                        // 停止执行
  parseAndEmitEvents(chunk)     // 解析事件流
}
```

**事件类型**：
- `step` - 执行步骤更新
- `tool` - 工具调用
- `file` - 文件操作
- `message` - 消息
- `progress` - 进度更新
- `error` - 错误

---

### 2. IPC 接口

**位置**：`client/electron/main.js`

**新增 IPC Handlers**：

```javascript
// 执行 Agent 任务
ipcMain.handle('agent-execute', async (event, { agentId, prompt, options }))

// 停止执行
ipcMain.handle('agent-stop', async (event, { executionId }))

// 获取可用 Agent 列表
ipcMain.handle('agent-list-available', async ())
```

**事件推送**：
```javascript
// Agent 执行事件（推送到渲染进程）
event.sender.send('agent-event', { executionId, type, data })
```

---

### 3. Debug 页面改造

**位置**：`client/src/pages/Debug.jsx`

**新增状态**：
```javascript
const [mode, setMode] = useState('llm');  // 'llm' | 'agent'
const [agents, setAgents] = useState([]);
const [selectedAgent, setSelectedAgent] = useState(null);
const [execution, setExecution] = useState(null);
const [executionHistory, setExecutionHistory] = useState([]);
```

**UI 扩展**：
```
┌────────────────────────────────────────┐
│ [🐛 LLM 调试] [🤖 Agent 工作] ← 模式切换│
├────────────────────────────────────────┤
│ Agent 模式工具栏：                      │
│  [Agent选择] [助手选择] [工作目录]      │
├────────────────────────────────────────┤
│ 对话区（支持执行过程展示）               │
├────────────────────────────────────────┤
│ 输入框                                  │
└────────────────────────────────────────┘
```

---

### 4. AgentExecution 组件

**位置**：`client/src/components/AgentExecution.jsx`（新建）

**展示内容**：
- 📋 执行摘要（状态、耗时、Token、成本）
- 🔄 步骤列表（每步的状态和描述）
- 🔧 工具调用（工具名、参数、结果）
- 📄 文件操作（创建/修改的文件列表）
- 💬 消息历史（Agent 与用户的对话）

---

## 🔨 实施步骤

### 第一步：创建 AgentExecutor（2 天）

1. **创建文件**：`client/electron/agent-executor.js`

```javascript
import { EventEmitter } from 'events';
import { spawn } from 'child_process';

export class AgentExecutor extends EventEmitter {
  constructor(agentId, config) {
    super();
    this.agentId = agentId;
    this.config = config;
    this.process = null;
    this.executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  async execute(prompt, options = {}) {
    // TODO: 根据 agentId 调用不同的执行逻辑
    switch (this.agentId) {
      case 'aionui-desktop':
        return await this.executeAionUi(prompt, options);
      case 'claude-code':
        return await this.executeClaudeCode(prompt, options);
      // ... 其他 Agent
    }
  }

  async executeAionUi(prompt, options) {
    // TODO: 实现 AionUi 调用逻辑
    // 1. 启动 AionUi（如果未运行）
    // 2. 发送任务请求
    // 3. 监听执行事件
  }

  async executeClaudeCode(prompt, options) {
    // TODO: 实现 Claude Code 调用逻辑
    // 1. 启动 claude CLI 进程
    // 2. 发送提示
    // 3. 解析输出流
  }

  parseAndEmitEvents(chunk) {
    // TODO: 解析事件并发射
    const lines = chunk.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        this.emit(event.type, event.data);
      } catch {
        this.emit('output', line);
      }
    }
  }

  stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
    }
  }
}
```

2. **测试**：
```bash
# 创建测试文件
node test-agent-executor.js
```

---

### 第二步：添加 IPC 接口（1 天）

1. **修改文件**：`client/electron/main.js`

```javascript
import { AgentExecutor } from './agent-executor.js';

const executors = new Map();

ipcMain.handle('agent-execute', async (event, { agentId, prompt, options }) => {
  const executor = new AgentExecutor(agentId, options);
  const executionId = executor.executionId;
  
  executors.set(executionId, executor);
  
  // 转发事件到渲染进程
  executor.on('step', data => 
    event.sender.send('agent-event', { executionId, type: 'step', data })
  );
  
  // ... 其他事件监听
  
  try {
    const result = await executor.execute(prompt, options);
    return { success: true, executionId, result };
  } catch (error) {
    return { success: false, executionId, error: error.message };
  }
});

ipcMain.handle('agent-stop', async (event, { executionId }) => {
  const executor = executors.get(executionId);
  if (executor) {
    executor.stop();
    executors.delete(executionId);
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('agent-list-available', async () => {
  // 从数据库读取已纳管的 Agent
  const managed = await db.all(
    'SELECT * FROM managed_agents WHERE status != "reverted"'
  );
  
  return managed.map(m => ({
    id: m.agent_id,
    name: getAgentDisplayName(m.agent_id),
    status: m.status,
    capabilities: getAgentCapabilities(m.agent_id),
  }));
});
```

2. **修改文件**：`client/electron/preload.js`

```javascript
contextBridge.exposeInMainWorld('electronAPI', {
  // ... 现有 API
  
  // 新增 Agent 相关 API
  agentExecute: (params) => ipcRenderer.invoke('agent-execute', params),
  agentStop: (params) => ipcRenderer.invoke('agent-stop', params),
  agentListAvailable: () => ipcRenderer.invoke('agent-list-available'),
  
  // 监听 Agent 事件
  onAgentEvent: (callback) => {
    ipcRenderer.on('agent-event', (event, data) => callback(event, data));
  },
  offAgentEvent: (callback) => {
    ipcRenderer.removeListener('agent-event', callback);
  },
});
```

---

### 第三步：改造 Debug 页面（2 天）

1. **添加模式切换**：

```jsx
{/* 顶部模式切换 */}
<div className="flex gap-2 px-4 py-2 border-b">
  <button 
    onClick={() => setMode('llm')}
    className={mode === 'llm' ? 'active' : ''}
  >
    🐛 LLM 调试
  </button>
  <button 
    onClick={() => setMode('agent')}
    className={mode === 'agent' ? 'active' : ''}
  >
    🤖 Agent 工作
  </button>
</div>
```

2. **添加 Agent 选择器**：

```jsx
{mode === 'agent' && (
  <div className="flex gap-2 px-4 py-2">
    <select 
      value={selectedAgent?.id || ''} 
      onChange={e => setSelectedAgent(agents.find(a => a.id === e.target.value))}
    >
      <option value="">选择 Agent</option>
      {agents.map(a => (
        <option key={a.id} value={a.id}>{a.name}</option>
      ))}
    </select>
    
    {/* AionUi 助手选择 */}
    {selectedAgent?.id === 'aionui-desktop' && (
      <select value={selectedAssistant?.id || ''} onChange={...}>
        <option value="">选择助手</option>
        {/* 助手列表 */}
      </select>
    )}
  </div>
)}
```

3. **修改发送逻辑**：

```jsx
async function handleSend() {
  if (mode === 'llm') {
    // 现有 LLM 逻辑
    await doStreamChat(...);
  } else {
    // Agent 模式
    const result = await window.electronAPI.agentExecute({
      agentId: selectedAgent.id,
      prompt: input.trim(),
      options: { workingDir, assistantType: selectedAssistant?.name }
    });
    
    // 处理结果...
  }
}
```

4. **监听执行事件**：

```jsx
useEffect(() => {
  if (mode === 'agent') {
    const handler = (event, { executionId, type, data }) => {
      setExecution(prev => {
        // 更新执行状态
        return { ...prev, [type]: [...(prev[type] || []), data] };
      });
    };
    
    window.electronAPI.onAgentEvent(handler);
    return () => window.electronAPI.offAgentEvent(handler);
  }
}, [mode]);
```

---

### 第四步：创建 AgentExecution 组件（1 天）

1. **创建文件**：`client/src/components/AgentExecution.jsx`

```jsx
export default function AgentExecution({ execution }) {
  const [activeTab, setActiveTab] = useState('summary');
  
  return (
    <div className="agent-execution">
      {/* 状态摘要 */}
      <div className="summary">
        <StatusBadge status={execution.status} />
        <Stats duration={execution.duration} tokens={execution.tokens} />
      </div>
      
      {/* 标签页 */}
      <div className="tabs">
        <Tab id="summary" label="概览" active={activeTab} />
        <Tab id="steps" label="步骤" count={execution.steps?.length} />
        <Tab id="tools" label="工具" count={execution.toolCalls?.length} />
        <Tab id="files" label="文件" count={execution.files?.length} />
      </div>
      
      {/* 内容区 */}
      <div className="content">
        {activeTab === 'summary' && <Summary {...execution} />}
        {activeTab === 'steps' && <StepsList steps={execution.steps} />}
        {activeTab === 'tools' && <ToolsList tools={execution.toolCalls} />}
        {activeTab === 'files' && <FilesList files={execution.files} />}
      </div>
    </div>
  );
}
```

---

## 🧪 测试计划

### 单元测试

```javascript
// test/agent-executor.test.js
describe('AgentExecutor', () => {
  it('should create executor with correct id', () => {
    const executor = new AgentExecutor('aionui-desktop');
    expect(executor.agentId).toBe('aionui-desktop');
  });
  
  it('should emit events correctly', () => {
    const executor = new AgentExecutor('test');
    const stepHandler = jest.fn();
    executor.on('step', stepHandler);
    
    executor.emit('step', { step: 1, status: 'running' });
    expect(stepHandler).toHaveBeenCalledWith({ step: 1, status: 'running' });
  });
});
```

### 集成测试

```javascript
// test/agent-integration.test.js
describe('Agent Integration', () => {
  it('should execute AionUi task', async () => {
    const result = await window.electronAPI.agentExecute({
      agentId: 'aionui-desktop',
      prompt: 'Create a test PPT',
      options: { assistantType: 'PPT Creator' }
    });
    
    expect(result.success).toBe(true);
    expect(result.files).toContain('test.pptx');
  });
});
```

---

## 📋 检查清单

### 代码修改

- [ ] `client/electron/agent-executor.js` - 创建执行引擎
- [ ] `client/electron/main.js` - 添加 IPC handlers
- [ ] `client/electron/preload.js` - 暴露 API
- [ ] `client/src/pages/Debug.jsx` - 添加 Agent 模式
- [ ] `client/src/components/AgentExecution.jsx` - 创建执行结果组件

### 功能实现

- [ ] 模式切换（LLM / Agent）
- [ ] Agent 列表加载
- [ ] Agent 选择器
- [ ] AionUi 助手选择（仅 AionUi）
- [ ] 工作目录选择
- [ ] 执行任务
- [ ] 实时进度显示
- [ ] 步骤列表展示
- [ ] 工具调用展示
- [ ] 文件列表展示
- [ ] 停止执行
- [ ] 错误处理

### 测试

- [ ] 单元测试（AgentExecutor）
- [ ] 集成测试（各 Agent）
- [ ] UI 测试（模式切换、选择器）
- [ ] 性能测试（大量输出）

---

## 🎯 MVP 范围

### 第一版（2 周）

**必须实现**：
- ✅ 模式切换 UI
- ✅ Agent 选择器
- ✅ AionUi 基础集成（Cowork 助手）
- ✅ 执行状态显示（运行中/完成/失败）
- ✅ 基础结果展示（摘要）

**可以延后**：
- ⏸️ Claude Code / Codex 集成
- ⏸️ 详细步骤展示
- ⏸️ 工具调用展示
- ⏸️ 文件预览

---

## 🚀 快速开始

### 1. 创建基础结构

```bash
# 创建新文件
touch client/electron/agent-executor.js
touch client/src/components/AgentExecution.jsx

# 修改现有文件
code client/electron/main.js
code client/electron/preload.js
code client/src/pages/Debug.jsx
```

### 2. 安装依赖（如需要）

```bash
cd client
npm install  # 确保所有依赖已安装
```

### 3. 启动开发

```bash
# 启动 Electron 应用
npm run dev
```

### 4. 测试流程

1. 打开 Debug 页面
2. 切换到 "Agent 工作" 模式
3. 选择一个 Agent（如 AionUi）
4. 输入任务描述
5. 点击发送
6. 观察执行过程

---

## 💡 开发提示

### AionUi 集成建议

由于 AionUi 是独立的 Electron 应用，集成方式：

**方案 A：IPC 通信**（推荐）
- Token Bank 作为主应用
- AionUi 作为子窗口或独立进程
- 通过 IPC 发送任务和接收结果

**方案 B：CLI 包装**
- 如果 AionUi 提供 CLI 模式
- 通过 spawn 启动并控制

**方案 C：共享数据库**
- Token Bank 写入任务到数据库
- AionUi 读取并执行
- 通过数据库同步状态

### Claude Code / Codex 集成

这两个都是 CLI 工具，集成相对简单：

```javascript
const process = spawn('claude', [
  '--model', 'claude-sonnet-4-6',
  '--output-json'
]);

process.stdout.on('data', data => {
  const lines = data.toString().split('\n');
  for (const line of lines) {
    const event = JSON.parse(line);
    // 处理事件
  }
});
```

---

## 📚 参考资料

- [AionUi 项目](https://github.com/iOfficeAI/AionUi)
- [Claude Code 文档](https://github.com/anthropics/claude-code)
- [Codex CLI](https://github.com/openai/openai-codex)
- [Electron IPC 通信](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [Node.js child_process](https://nodejs.org/api/child_process.html)

---

_快速指南版本：v1.0 | 2026-07-05_
