# Agent 聚合入口设计方案

> 将 Debug 页面升级为统一的 Agent 调用入口  
> 不仅调试模型，还能直接调用 Agent 完成实际工作

---

## 🎯 设计目标

### 当前 Debug 页面的局限
- ✅ 可以测试 LLM 模型调用
- ✅ 支持聊天和图像生成
- ❌ 无法调用已纳管的 Agent（Claude Code、Codex、AionUi）
- ❌ 无法使用 Agent 的特殊能力（文件操作、代码执行、Office 生成）
- ❌ 只能看到 LLM 响应，看不到 Agent 执行过程

### 升级后的目标
- ✅ **模型调试** + **Agent 工作**二合一
- ✅ 统一入口调用所有已纳管的 Agent
- ✅ 展示 Agent 执行过程（工具调用、文件操作）
- ✅ 支持 Agent 特有功能（AionUi Office 助手、Codex 代码执行）
- ✅ 保留原有模型调试能力

---

## 🏗️ 架构设计

### 三层架构

```
┌─────────────────────────────────────────────────────────┐
│  Debug / Agent 聚合页面（前端）                           │
│  ├─ 模式选择：LLM 模式 / Agent 模式                      │
│  ├─ Agent 选择器（已纳管的 Agent 列表）                  │
│  ├─ 对话界面（支持富文本、文件、工具调用展示）             │
│  └─ 执行结果展示（文件预览、图表、Office 文档）           │
└──────────────────┬──────────────────────────────────────┘
                   │
    ┌──────────────┴─────────────┐
    │                            │
    ▼                            ▼
┌────────────┐            ┌──────────────┐
│ LLM 模式   │            │ Agent 模式    │
│ (现有逻辑) │            │ (新增功能)    │
└──────┬─────┘            └──────┬───────┘
       │                         │
       │                         │
       ▼                         ▼
┌─────────────────┐     ┌──────────────────────┐
│ 直接调用 LLM    │     │ Agent Execution      │
│ • Chat          │     │ Engine               │
│ • Image Gen     │     │                      │
└─────────────────┘     │ ├─ Claude Code       │
                        │ ├─ Codex             │
                        │ ├─ AionUi            │
                        │ ├─ Cursor            │
                        │ └─ 其他纳管 Agent     │
                        └──────────────────────┘
```

### 模式对比

| 维度 | LLM 模式（现有） | Agent 模式（新增） |
|-----|----------------|------------------|
| 调用对象 | 直接调用模型 | 通过 Agent 调用 |
| 能力范围 | 对话 + 图像生成 | 文件操作 + 代码执行 + Office 生成 + 工具调用 |
| 执行过程 | 仅显示模型响应 | 显示完整执行链路（工具调用、文件读写） |
| 结果类型 | 文本 / 图片 | 文本 + 文件 + 图表 + Office 文档 |
| 使用场景 | 调试模型 | 完成实际工作 |

---

## 🎨 界面设计

### 顶部工具栏扩展

```
┌──────────────────────────────────────────────────────────┐
│  [模式] LLM 模式  |  Agent 模式  ← 新增模式切换            │
├──────────────────────────────────────────────────────────┤
│  LLM 模式（现有）                                         │
│  [Provider] 本地网关 ▼  [Model] gpt-4o ▼  [💬 聊天/🎨 图像]│
├──────────────────────────────────────────────────────────┤
│  Agent 模式（新增）                                       │
│  [Agent] AionUi Desktop ▼  [助手] Cowork ▼  [工作区] 选择文件夹│
│  ├─ Claude Code                                          │
│  ├─ Codex                                                │
│  ├─ AionUi Desktop                                       │
│  │   ├─ Cowork                                           │
│  │   ├─ PPT Creator                                      │
│  │   ├─ Word Creator                                     │
│  │   ├─ Excel Creator                                    │
│  │   └─ ...                                              │
│  ├─ Cursor                                               │
│  └─ OpenCode                                             │
└──────────────────────────────────────────────────────────┘
```

### 对话区增强

**LLM 模式**（保持现有）：
```
┌──────────────────────────────────────┐
│ 👤 User: 帮我写一个快速排序           │
├──────────────────────────────────────┤
│ 🤖 AI: 这是快速排序的实现：          │
│                                      │
│ def quicksort(arr): ...              │
└──────────────────────────────────────┘
```

**Agent 模式**（新增）：
```
┌──────────────────────────────────────────────────────────┐
│ 👤 User: 帮我生成一份销售报表的 PPT                       │
├──────────────────────────────────────────────────────────┤
│ 🤖 AionUi (PPT Creator):                                 │
│                                                          │
│ 📋 执行步骤：                                            │
│   ✅ 1. 读取数据文件 sales_data.csv                      │
│   ✅ 2. 分析销售趋势                                     │
│   ⏳ 3. 生成 PPT 结构                                    │
│   ⏸️ 4. 创建图表                                         │
│   ⏸️ 5. 生成 Morph 动画                                  │
│                                                          │
│ 🔧 工具调用：                                            │
│   • read_file('sales_data.csv')                         │
│   • analyze_data(data)                                  │
│   • generate_ppt(structure)                             │
│                                                          │
│ 📄 生成文件：                                            │
│   • sales_report.pptx [预览] [下载] [在 PPT 中打开]      │
│                                                          │
│ ✅ 完成！耗时 45.3s，Token: 12.5K，成本: $0.023         │
└──────────────────────────────────────────────────────────┘
```

### 执行过程展示

**实时进度**：
```
┌───────────────────────────────────────┐
│ 🔄 正在执行...                        │
│                                       │
│ [████████░░░░░░░░] 60%                │
│                                       │
│ 当前步骤: 生成图表                     │
│ 已用时间: 28.5s                       │
│ 已消耗 Token: 8.2K                    │
└───────────────────────────────────────┘
```

**工具调用展开**：
```
┌──────────────────────────────────────┐
│ 🔧 read_file                          │
│    path: "sales_data.csv"            │
│    ✅ 成功 (102 行)                   │
├──────────────────────────────────────┤
│ 🔧 analyze_data                       │
│    data: [...]                       │
│    ✅ 成功                            │
│    结果: { trend: "上升", ... }       │
├──────────────────────────────────────┤
│ 🔧 generate_chart                     │
│    type: "line"                      │
│    data: [...]                       │
│    ⏳ 执行中...                       │
└──────────────────────────────────────┘
```

---

## 🔧 技术实现

### 1. Agent 执行引擎

#### 文件：`client/electron/agent-executor.js`（新建）

```javascript
/**
 * Agent 执行引擎 - 统一调用各种 Agent
 */

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

export class AgentExecutor extends EventEmitter {
  constructor(agentId, config = {}) {
    super();
    this.agentId = agentId;
    this.config = config;
    this.process = null;
    this.executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * 执行 Agent 任务
   * @param {string} prompt - 用户提示
   * @param {Object} options - 执行选项
   */
  async execute(prompt, options = {}) {
    const { workingDir, model, assistantType } = options;

    switch (this.agentId) {
      case 'aionui':
        return await this.executeAionUi(prompt, { workingDir, assistantType });
      
      case 'claude-code':
        return await this.executeClaudeCode(prompt, { workingDir, model });
      
      case 'codex':
        return await this.executeCodex(prompt, { workingDir, model });
      
      case 'cursor':
        return await this.executeCursor(prompt, { workingDir });
      
      default:
        throw new Error(`Unknown agent: ${this.agentId}`);
    }
  }

  /**
   * 执行 AionUi Agent
   */
  async executeAionUi(prompt, options) {
    const { workingDir, assistantType = 'Cowork' } = options;

    // 1. 启动 AionUi（如果未运行）
    await this.ensureAionUiRunning();

    // 2. 通过 IPC/WebSocket 发送任务
    const response = await this.sendToAionUi({
      type: 'execute_task',
      executionId: this.executionId,
      prompt,
      assistantType,
      workingDir,
    });

    // 3. 监听执行事件
    this.subscribeAionUiEvents(this.executionId);

    return response;
  }

  /**
   * 执行 Claude Code
   */
  async executeClaudeCode(prompt, options) {
    const { workingDir, model = 'claude-sonnet-4-6' } = options;

    // 启动 claude-code 进程
    const claudePath = path.join(os.homedir(), '.claude/bin/claude');
    
    this.process = spawn(claudePath, [
      '--model', model,
      '--working-dir', workingDir || process.cwd(),
      '--non-interactive',
      '--output-json',
    ]);

    // 发送任务
    this.process.stdin.write(JSON.stringify({ prompt }) + '\n');

    // 监听输出
    return new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';

      this.process.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        
        // 解析 JSON 行协议
        this.parseAndEmitEvents(chunk);
      });

      this.process.stderr.on('data', (data) => {
        errorOutput += data.toString();
        this.emit('error', data.toString());
      });

      this.process.on('close', (code) => {
        if (code === 0) {
          resolve({ output, executionId: this.executionId });
        } else {
          reject(new Error(`Claude Code exited with code ${code}: ${errorOutput}`));
        }
      });
    });
  }

  /**
   * 执行 Codex
   */
  async executeCodex(prompt, options) {
    // 类似 Claude Code，但调用 codex CLI
    // ...
  }

  /**
   * 解析并发射事件
   */
  parseAndEmitEvents(chunk) {
    const lines = chunk.split('\n').filter(Boolean);
    
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        
        switch (event.type) {
          case 'step_start':
            this.emit('step', { 
              step: event.step, 
              status: 'running',
              description: event.description 
            });
            break;
          
          case 'step_complete':
            this.emit('step', { 
              step: event.step, 
              status: 'completed' 
            });
            break;
          
          case 'tool_call':
            this.emit('tool', {
              tool: event.tool_name,
              args: event.args,
              status: 'called'
            });
            break;
          
          case 'tool_result':
            this.emit('tool', {
              tool: event.tool_name,
              result: event.result,
              status: 'completed'
            });
            break;
          
          case 'file_created':
            this.emit('file', {
              action: 'created',
              path: event.path,
              size: event.size
            });
            break;
          
          case 'message':
            this.emit('message', {
              role: event.role,
              content: event.content
            });
            break;
          
          case 'progress':
            this.emit('progress', {
              percentage: event.percentage,
              current_step: event.current_step,
              total_steps: event.total_steps
            });
            break;
        }
      } catch (e) {
        // 非 JSON 行，作为普通输出
        this.emit('output', line);
      }
    }
  }

  /**
   * 停止执行
   */
  stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
    }
  }

  /**
   * 确保 AionUi 运行中
   */
  async ensureAionUiRunning() {
    // 检查 AionUi 是否运行
    // 如果未运行，启动它
    // ...
  }

  /**
   * 向 AionUi 发送消息
   */
  async sendToAionUi(message) {
    // 通过 IPC/WebSocket 与 AionUi 通信
    // ...
  }

  /**
   * 订阅 AionUi 执行事件
   */
  subscribeAionUiEvents(executionId) {
    // 监听 AionUi 的执行事件
    // ...
  }
}
```

---

### 2. IPC 接口

#### 文件：`client/electron/main.js` 扩展

```javascript
import { AgentExecutor } from './agent-executor.js';

// 全局执行器映射
const executors = new Map();

ipcMain.handle('agent-execute', async (event, { agentId, prompt, options }) => {
  const executionId = `exec-${Date.now()}`;
  const executor = new AgentExecutor(agentId, options);
  
  executors.set(executionId, executor);
  
  // 转发执行事件到渲染进程
  executor.on('step', (data) => {
    event.sender.send('agent-event', { executionId, type: 'step', data });
  });
  
  executor.on('tool', (data) => {
    event.sender.send('agent-event', { executionId, type: 'tool', data });
  });
  
  executor.on('file', (data) => {
    event.sender.send('agent-event', { executionId, type: 'file', data });
  });
  
  executor.on('message', (data) => {
    event.sender.send('agent-event', { executionId, type: 'message', data });
  });
  
  executor.on('progress', (data) => {
    event.sender.send('agent-event', { executionId, type: 'progress', data });
  });
  
  executor.on('error', (error) => {
    event.sender.send('agent-event', { executionId, type: 'error', data: error });
  });
  
  try {
    const result = await executor.execute(prompt, options);
    return { success: true, executionId, result };
  } catch (error) {
    return { success: false, executionId, error: error.message };
  } finally {
    // 清理
    setTimeout(() => executors.delete(executionId), 60000);
  }
});

ipcMain.handle('agent-stop', async (event, { executionId }) => {
  const executor = executors.get(executionId);
  if (executor) {
    executor.stop();
    executors.delete(executionId);
    return { success: true };
  }
  return { success: false, error: 'Execution not found' };
});

ipcMain.handle('agent-list-available', async () => {
  // 返回所有已纳管的 Agent
  const agents = [];
  
  // 从 managed_agents 表读取
  const managed = await db.all('SELECT * FROM managed_agents WHERE status != "reverted"');
  
  for (const m of managed) {
    const agent = {
      id: m.agent_id,
      name: getAgentDisplayName(m.agent_id),
      status: m.status,
      capabilities: getAgentCapabilities(m.agent_id),
    };
    
    // AionUi 特殊处理：列出助手
    if (m.agent_id === 'aionui-desktop') {
      agent.assistants = await getAionUiAssistants();
    }
    
    agents.push(agent);
  }
  
  return agents;
});

function getAgentCapabilities(agentId) {
  const capMap = {
    'aionui-desktop': ['chat', 'office', 'schedule', 'file_ops'],
    'claude-code': ['chat', 'code', 'file_ops', 'shell'],
    'codex': ['chat', 'code', 'file_ops', 'shell'],
    'cursor': ['chat', 'code', 'file_ops'],
  };
  return capMap[agentId] || ['chat'];
}

async function getAionUiAssistants() {
  // 从 AionUi 配置或数据库读取助手列表
  return [
    { id: 'cowork', name: 'Cowork', icon: '🤝' },
    { id: 'ppt-creator', name: 'PPT Creator', icon: '📊' },
    { id: 'word-creator', name: 'Word Creator', icon: '📝' },
    { id: 'excel-creator', name: 'Excel Creator', icon: '📗' },
    { id: 'academic-paper', name: 'Academic Paper Writer', icon: '🎓' },
    { id: 'planning', name: 'Planning with Files', icon: '📋' },
  ];
}
```

---

### 3. 前端组件改造

#### 文件：`client/src/pages/Debug.jsx` 扩展

```javascript
import React, { useState, useEffect, useRef } from 'react';
// ... 现有导入

// 新增导入
import AgentSelector from '../components/AgentSelector';
import AgentExecution from '../components/AgentExecution';

export default function Debug() {
  const { t } = useLang();
  
  // 现有状态
  // ...
  
  // 新增状态
  const [mode, setMode] = useState('llm'); // 'llm' | 'agent'
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [selectedAssistant, setSelectedAssistant] = useState(null);
  const [workingDir, setWorkingDir] = useState('');
  const [execution, setExecution] = useState(null); // 当前执行状态
  const [executionHistory, setExecutionHistory] = useState([]); // 执行历史

  // 加载可用 Agent
  useEffect(() => {
    if (mode === 'agent') {
      window.electronAPI.agentListAvailable().then(list => {
        setAgents(list);
        if (list.length > 0 && !selectedAgent) {
          setSelectedAgent(list[0]);
        }
      });
    }
  }, [mode]);

  // 监听 Agent 执行事件
  useEffect(() => {
    if (mode === 'agent') {
      const handler = (event, { executionId, type, data }) => {
        if (!execution || execution.id !== executionId) return;
        
        setExecution(prev => {
          const updated = { ...prev };
          
          switch (type) {
            case 'step':
              updated.steps = updated.steps || [];
              const existingStep = updated.steps.find(s => s.step === data.step);
              if (existingStep) {
                Object.assign(existingStep, data);
              } else {
                updated.steps.push(data);
              }
              break;
            
            case 'tool':
              updated.toolCalls = updated.toolCalls || [];
              updated.toolCalls.push(data);
              break;
            
            case 'file':
              updated.files = updated.files || [];
              updated.files.push(data);
              break;
            
            case 'message':
              updated.messages = updated.messages || [];
              updated.messages.push(data);
              break;
            
            case 'progress':
              updated.progress = data;
              break;
            
            case 'error':
              updated.error = data;
              updated.status = 'failed';
              break;
          }
          
          return updated;
        });
      };
      
      window.electronAPI.onAgentEvent(handler);
      return () => window.electronAPI.offAgentEvent(handler);
    }
  }, [mode, execution]);

  // Agent 模式发送
  async function handleAgentSend() {
    const text = input.trim();
    if (!text || !selectedAgent || sending) return;

    const executionId = `exec-${Date.now()}`;
    
    // 添加到对话历史
    setPanel({ 
      input: '',
      conversation: [
        ...conversation, 
        { role: 'user', content: text },
        { role: 'assistant', agent: selectedAgent.id, executing: true }
      ]
    });

    // 初始化执行状态
    setExecution({
      id: executionId,
      agentId: selectedAgent.id,
      assistantId: selectedAssistant?.id,
      prompt: text,
      status: 'running',
      startTime: Date.now(),
      steps: [],
      toolCalls: [],
      files: [],
      messages: [],
      progress: null,
    });

    setSending(true);

    try {
      const result = await window.electronAPI.agentExecute({
        agentId: selectedAgent.id,
        prompt: text,
        options: {
          workingDir: workingDir || undefined,
          assistantType: selectedAssistant?.name,
          model: model || undefined,
        }
      });

      if (result.success) {
        setExecution(prev => ({
          ...prev,
          status: 'completed',
          endTime: Date.now(),
          result: result.result,
        }));
        
        // 更新对话历史
        setPanels(prev => {
          const p = prev.main;
          const next = [...p.conversation];
          const lastIdx = next.length - 1;
          next[lastIdx] = {
            ...next[lastIdx],
            executing: false,
            execution: execution,
          };
          return { ...prev, main: { ...p, conversation: next } };
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      setExecution(prev => ({
        ...prev,
        status: 'failed',
        error: error.message,
      }));
    } finally {
      setSending(false);
      
      // 保存到历史
      setExecutionHistory(prev => [execution, ...prev.slice(0, 19)]);
    }
  }

  // 停止执行
  async function handleStopExecution() {
    if (execution && execution.status === 'running') {
      await window.electronAPI.agentStop({ executionId: execution.id });
      setExecution(prev => ({ ...prev, status: 'stopped' }));
      setSending(false);
    }
  }

  // 选择工作目录
  async function handleSelectWorkingDir() {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory']
    });
    if (result && !result.canceled && result.filePaths.length > 0) {
      setWorkingDir(result.filePaths[0]);
    }
  }

  // 修改发送逻辑
  async function handleSend() {
    if (mode === 'llm') {
      // 现有 LLM 模式逻辑
      // ...
    } else {
      // Agent 模式
      await handleAgentSend();
    }
  }

  return (
    <div className="flex flex-col h-screen">
      
      {/* ── Mode Switcher (新增) ── */}
      <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 px-4 py-2">
        <div className="flex gap-2">
          <button 
            onClick={() => setMode('llm')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              mode === 'llm' 
                ? 'bg-blue-600 text-white' 
                : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-600'
            }`}
          >
            🐛 LLM 调试
          </button>
          <button 
            onClick={() => setMode('agent')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              mode === 'agent' 
                ? 'bg-blue-600 text-white' 
                : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-600'
            }`}
          >
            🤖 Agent 工作
          </button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 px-4 pt-3 pb-2 space-y-2">
        
        {mode === 'llm' ? (
          // 现有 LLM 模式工具栏
          <>{/* ... 现有代码 ... */}</>
        ) : (
          // Agent 模式工具栏（新增）
          <>
            <div className="flex gap-2 items-center flex-wrap">
              {/* Agent 选择器 */}
              <select 
                value={selectedAgent?.id || ''} 
                onChange={e => {
                  const agent = agents.find(a => a.id === e.target.value);
                  setSelectedAgent(agent);
                  setSelectedAssistant(null);
                }}
                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500"
              >
                <option value="">选择 Agent</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} {a.status === 'tracked_via_gateway' ? '(走网关)' : ''}
                  </option>
                ))}
              </select>

              {/* AionUi 助手选择器 */}
              {selectedAgent?.id === 'aionui-desktop' && selectedAgent.assistants && (
                <select 
                  value={selectedAssistant?.id || ''} 
                  onChange={e => {
                    const assistant = selectedAgent.assistants.find(a => a.id === e.target.value);
                    setSelectedAssistant(assistant);
                  }}
                  className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="">选择助手</option>
                  {selectedAgent.assistants.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.icon} {a.name}
                    </option>
                  ))}
                </select>
              )}

              {/* 工作目录选择 */}
              <div className="flex gap-1 items-center">
                <input 
                  value={workingDir} 
                  onChange={e => setWorkingDir(e.target.value)}
                  placeholder="工作目录（可选）"
                  className="w-64 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500"
                />
                <button 
                  onClick={handleSelectWorkingDir}
                  className="px-2 py-1.5 text-xs bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                >
                  📁 选择
                </button>
              </div>

              {/* 能力标签 */}
              {selectedAgent?.capabilities && (
                <div className="flex gap-1 ml-auto">
                  {selectedAgent.capabilities.map(cap => (
                    <span 
                      key={cap} 
                      className="px-2 py-0.5 text-xs rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 执行中状态栏 */}
            {execution && execution.status === 'running' && (
              <div className="flex gap-2 items-center p-2 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
                <span className="w-4 h-4 border-2 border-blue-700 border-t-blue-300 rounded-full animate-spin" />
                <span className="text-sm text-blue-700 dark:text-blue-300">
                  正在执行... {execution.progress?.percentage ? `${execution.progress.percentage}%` : ''}
                </span>
                {execution.progress?.current_step && (
                  <span className="text-xs text-blue-600 dark:text-blue-400">
                    {execution.progress.current_step}
                  </span>
                )}
                <button 
                  onClick={handleStopExecution}
                  className="ml-auto px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 rounded transition-colors"
                >
                  停止
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {conversation.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-zinc-400 dark:text-zinc-400 select-none">
            <p className="text-3xl mb-2">{mode === 'llm' ? (imageMode ? '🎨' : '🐛') : '🤖'}</p>
            <p className="text-sm">
              {mode === 'llm' 
                ? (imageMode ? t('debug.emptyImage') : t('debug.emptyChat'))
                : '选择一个 Agent 开始工作'
              }
            </p>
          </div>
        )}

        {conversation.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {/* User message - 保持现有样式 */}
            {msg.role === 'user' && (
              <>{/* ... 现有用户消息渲染 ... */}</>
            )}

            {/* Assistant message */}
            {msg.role === 'assistant' && (
              <>
                {mode === 'llm' ? (
                  // LLM 模式 - 现有渲染逻辑
                  <>{/* ... 现有 AI 消息渲染 ... */}</>
                ) : (
                  // Agent 模式 - 新增渲染
                  <div className="max-w-[85%]">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white text-xs">
                        🤖
                      </div>
                      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                        {selectedAgent?.name} 
                        {selectedAssistant && ` · ${selectedAssistant.name}`}
                      </span>
                    </div>

                    {msg.executing ? (
                      // 执行中
                      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl p-4">
                        <div className="flex items-center gap-2 text-sm text-zinc-400">
                          <span className="w-4 h-4 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
                          执行中...
                        </div>
                      </div>
                    ) : msg.execution ? (
                      // 执行完成 - 显示详细信息
                      <AgentExecution execution={msg.execution} />
                    ) : null}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ── */}
      <div className="shrink-0 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 px-4 py-3">
        <div className="flex gap-2 items-end">
          <textarea 
            ref={textareaRef} 
            value={input} 
            onChange={handleInputChange} 
            onKeyDown={handleKeyDown}
            placeholder={
              mode === 'llm' 
                ? (imageMode ? t('debug.inputImagePh') : t('debug.inputChatPh'))
                : '描述你想让 Agent 完成的任务...'
            }
            rows={1} 
            style={{ resize: 'none' }}
            className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500 overflow-hidden" 
          />
          <button 
            onClick={handleSend} 
            disabled={
              sending || 
              !input.trim() || 
              (mode === 'llm' ? (!model || !effectiveBase) : !selectedAgent)
            }
            className="shrink-0 w-9 h-9 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-40 rounded-xl flex items-center justify-center transition-colors"
          >
            {sending
              ? <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              : <span className="text-white text-sm">↑</span>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

### 4. Agent 执行结果组件

#### 文件：`client/src/components/AgentExecution.jsx`（新建）

```javascript
import React, { useState } from 'react';

export default function AgentExecution({ execution }) {
  const [expandedSection, setExpandedSection] = useState('summary');

  const { 
    status, 
    steps, 
    toolCalls, 
    files, 
    messages, 
    progress, 
    error,
    startTime,
    endTime,
    result 
  } = execution;

  const duration = endTime ? ((endTime - startTime) / 1000).toFixed(1) : null;
  const totalTokens = result?.usage?.total_tokens || 0;
  const cost = result?.usage?.cost_usd || 0;

  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl overflow-hidden">
      
      {/* 摘要 */}
      <div className="p-4 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {status === 'running' && (
              <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            )}
            {status === 'completed' && (
              <span className="text-green-500">✅</span>
            )}
            {status === 'failed' && (
              <span className="text-red-500">❌</span>
            )}
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {status === 'running' && '执行中'}
              {status === 'completed' && '执行完成'}
              {status === 'failed' && '执行失败'}
            </span>
          </div>
          {duration && (
            <span className="text-xs text-zinc-400">
              {duration}s · {(totalTokens / 1000).toFixed(1)}K tokens · ${cost.toFixed(3)}
            </span>
          )}
        </div>

        {/* 进度条 */}
        {status === 'running' && progress && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
              <span>{progress.current_step || '处理中'}</span>
              <span>{progress.percentage}%</span>
            </div>
            <div className="w-full h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
          </div>
        )}

        {/* 错误信息 */}
        {error && (
          <div className="mt-2 p-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* 详细信息标签页 */}
      <div className="border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex gap-1 px-2 pt-2">
          {[
            { id: 'summary', label: '📋 概览', count: null },
            { id: 'steps', label: '🔄 步骤', count: steps?.length },
            { id: 'tools', label: '🔧 工具', count: toolCalls?.length },
            { id: 'files', label: '📄 文件', count: files?.length },
            { id: 'messages', label: '💬 消息', count: messages?.length },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setExpandedSection(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors ${
                expandedSection === tab.id
                  ? 'bg-white dark:bg-zinc-800 text-blue-600 dark:text-blue-400'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
              }`}
            >
              {tab.label} {tab.count !== null && tab.count > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-700 rounded-full text-xs">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 内容区域 */}
      <div className="p-4 max-h-96 overflow-y-auto">
        
        {/* 概览 */}
        {expandedSection === 'summary' && (
          <div className="space-y-3">
            {result?.summary && (
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                {result.summary}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex justify-between">
                <span className="text-zinc-500">总步骤</span>
                <span className="font-medium">{steps?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">工具调用</span>
                <span className="font-medium">{toolCalls?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">生成文件</span>
                <span className="font-medium">{files?.filter(f => f.action === 'created').length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">耗时</span>
                <span className="font-medium">{duration}s</span>
              </div>
            </div>
          </div>
        )}

        {/* 步骤列表 */}
        {expandedSection === 'steps' && steps && (
          <div className="space-y-2">
            {steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs bg-zinc-100 dark:bg-zinc-700 text-zinc-500">
                  {i + 1}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">
                      {step.description || step.step}
                    </span>
                    {step.status === 'running' && (
                      <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                    )}
                    {step.status === 'completed' && (
                      <span className="text-green-500 text-xs">✓</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 工具调用 */}
        {expandedSection === 'tools' && toolCalls && (
          <div className="space-y-2">
            {toolCalls.map((tool, i) => (
              <div key={i} className="p-2 bg-zinc-50 dark:bg-zinc-900 rounded-lg">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-mono text-blue-600 dark:text-blue-400">
                    {tool.tool}
                  </span>
                  {tool.status === 'completed' && (
                    <span className="text-xs text-green-500">✓</span>
                  )}
                </div>
                {tool.args && (
                  <pre className="text-xs text-zinc-500 dark:text-zinc-400 overflow-x-auto">
                    {JSON.stringify(tool.args, null, 2)}
                  </pre>
                )}
                {tool.result && (
                  <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                    → {typeof tool.result === 'string' 
                        ? tool.result 
                        : JSON.stringify(tool.result).slice(0, 100)
                      }
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 文件列表 */}
        {expandedSection === 'files' && files && (
          <div className="space-y-2">
            {files.map((file, i) => (
              <div key={i} className="flex items-center justify-between p-2 bg-zinc-50 dark:bg-zinc-900 rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="text-lg">
                    {file.action === 'created' ? '📄' : '📝'}
                  </span>
                  <div>
                    <div className="text-sm font-mono text-zinc-700 dark:text-zinc-300">
                      {file.path.split('/').pop()}
                    </div>
                    <div className="text-xs text-zinc-400">
                      {file.path}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button 
                    onClick={() => window.electronAPI.showFileInFolder(file.path)}
                    className="px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 rounded"
                  >
                    打开
                  </button>
                  <button 
                    onClick={() => window.electronAPI.previewFile(file.path)}
                    className="px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 rounded"
                  >
                    预览
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 消息列表 */}
        {expandedSection === 'messages' && messages && (
          <div className="space-y-2">
            {messages.map((msg, i) => (
              <div key={i} className={`p-2 rounded-lg ${
                msg.role === 'user' 
                  ? 'bg-blue-50 dark:bg-blue-950' 
                  : 'bg-zinc-50 dark:bg-zinc-900'
              }`}>
                <div className="text-xs font-medium text-zinc-500 mb-1">
                  {msg.role === 'user' ? '用户' : 'Agent'}
                </div>
                <div className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                  {msg.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 📋 实施计划

### 阶段一：基础架构（1 周）
- [ ] 创建 `AgentExecutor` 类
- [ ] 实现基础的进程管理
- [ ] 添加 IPC 接口（`agent-execute`, `agent-stop`, `agent-list-available`）
- [ ] 前端添加模式切换 UI

### 阶段二：Agent 集成（2 周）
- [ ] 实现 AionUi 执行逻辑
  - [ ] IPC/WebSocket 通信
  - [ ] 助手类型选择
  - [ ] 执行事件监听
- [ ] 实现 Claude Code 执行
  - [ ] CLI 进程管理
  - [ ] JSON 行协议解析
- [ ] 实现 Codex 执行
- [ ] 实现 Cursor 集成（如果可行）

### 阶段三：UI 完善（1 周）
- [ ] 创建 `AgentExecution` 组件
- [ ] 实现步骤/工具/文件展示
- [ ] 添加进度指示器
- [ ] 文件预览集成
- [ ] 错误处理和重试

### 阶段四：测试优化（1 周）
- [ ] 单元测试
- [ ] 集成测试（各 Agent）
- [ ] 性能优化（大量输出处理）
- [ ] 用户体验优化

**总计：5 周**

---

## 🎁 核心价值

### 对用户
- ✅ **统一入口**：一个界面调用所有 Agent
- ✅ **实时反馈**：看到 Agent 执行的每一步
- ✅ **结果可见**：文件、图表、Office 文档即时预览
- ✅ **调试便捷**：既能测试模型，又能完成实际工作

### 对 Token Bank
- ✅ **功能增强**：Debug 页面从调试工具升级为生产力工具
- ✅ **生态完善**：充分利用已纳管的 Agent 能力
- ✅ **用户留存**：提供更多价值，用户更依赖平台
- ✅ **差异化**：市场上没有类似的 Agent 聚合调用界面

---

## 🔮 未来扩展

### 短期（1-3 个月）
- 支持更多 Agent（GitHub Copilot、Gemini CLI 等）
- Agent 协作模式（多个 Agent 并行/串行执行）
- 模板库（常用任务的预设提示）

### 中期（3-6 个月）
- Agent 工作流编排（可视化流程设计）
- 执行历史管理（保存、搜索、复用）
- 性能监控和优化建议

### 长期（6-12 个月）
- 自定义 Agent 开发工具
- Agent 市场（分享和下载 Agent 配置）
- 企业级功能（权限管理、审计日志）

---

_设计文档版本：v1.0 | 2026-07-05_
