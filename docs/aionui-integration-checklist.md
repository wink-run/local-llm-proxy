# AionUi 集成 - 技术实施清单

> 📌 基于方案一：AionUi 作为 Token Bank 前置 Agent  
> 🎯 目标：无侵入性集成，保持两个项目独立性

---

## ✅ 阶段一：基础集成（预计 1-2 周）

### 1.1 AionUi 检测模块

#### 文件：`client/electron/detect-tools.js`

- [ ] **新增 `detectAionUi()` 函数**
  - [ ] 检测 macOS 路径：`~/Library/Application Support/aionui`
  - [ ] 检测 Windows 路径：`~/AppData/Roaming/aionui`
  - [ ] 检测 Linux 路径：`~/.aionui`
  - [ ] 读取版本信息：`aionui/package.json` 或 `aionui/version.txt`
  - [ ] 检测配置文件：`aionui/config.json`
  - [ ] 检测数据库：`aionui/database.db`
  - [ ] 返回标准化的检测结果对象
  
- [ ] **修改 `detectInstalledTools()` 主函数**
  - [ ] 添加 AionUi 到检测列表
  - [ ] 并行检测所有工具
  - [ ] 过滤未检测到的工具

```javascript
// 期望的返回格式
{
  id: 'aionui-desktop',
  name: 'AionUi Desktop',
  detected: true,
  version: '1.5.0',
  platform: 'darwin',  // darwin/win32/linux
  configPath: '/Users/xxx/.aionui/config.json',
  databasePath: '/Users/xxx/.aionui/database.db',
  status: 'not_tracked'  // not_tracked/tracked/tracked_via_gateway
}
```

#### 测试用例

- [ ] ✅ 已安装 AionUi → 返回完整信息
- [ ] ✅ 未安装 AionUi → 返回 null
- [ ] ✅ 配置文件损坏 → 返回 detected=true, status=error
- [ ] ✅ 跨平台测试（Mac/Win/Linux）

---

### 1.2 一键纳管功能

#### 文件：`client/electron/agent-linker.js`

- [ ] **新增 `onboardAionUi(config)` 函数**
  - [ ] 参数验证：routeId（可选）
  - [ ] 生成专用 API Key：`tb-aionui-<uuid>`
  - [ ] 备份原始配置：`config.json` → `config.json.backup`
  - [ ] 读取现有配置（JSON 解析）
  - [ ] 插入 Token Bank Gateway 配置
  - [ ] 写回配置文件（格式化 JSON）
  - [ ] 更新纳管状态到数据库
  - [ ] 记录操作日志
  - [ ] 返回成功/失败状态 + API Key
  
- [ ] **新增 `revertAionUi()` 函数**
  - [ ] 读取配置文件
  - [ ] 移除 Token Bank Gateway 条目
  - [ ] 恢复备份（如果存在）
  - [ ] 更新纳管状态为 'reverted'
  - [ ] 保留历史路由配置（便于重新纳管）
  - [ ] 记录操作日志

```javascript
// AionUi config.json 修改示例
{
  "llmPlatforms": [
    // 现有配置保持不变
    {
      "type": "gemini",
      "apiKey": "xxx"
    },
    // 新增 Token Bank Gateway
    {
      "type": "custom",
      "id": "tokenbank-gateway",
      "name": "Token Bank Gateway",
      "baseUrl": "http://localhost:11430/v1",
      "apiKey": "tb-aionui-xxxxx",
      "models": [
        "gpt-4o",
        "gpt-4o-mini",
        "claude-sonnet-4-6",
        "claude-sonnet-4-0",
        "gemini-2.0-flash-exp",
        "llama-3.3-70b"
      ],
      "enabled": true,
      "managedBy": "TokenBank"  // 标记由 TB 管理
    }
  ]
}
```

#### 数据库扩展

- [ ] **扩展 `agents` 表（如果存在）或创建新表**

```sql
CREATE TABLE IF NOT EXISTS managed_agents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,  -- 'aionui-desktop'
  status TEXT NOT NULL,    -- 'tracked' / 'tracked_via_gateway' / 'reverted'
  route_id TEXT,           -- 关联的路由 ID
  api_key TEXT,            -- 生成的专用 Key
  config_backup TEXT,      -- JSON 格式的备份配置
  onboarded_at INTEGER,
  reverted_at INTEGER,
  last_seen INTEGER
);

CREATE INDEX IF NOT EXISTS idx_managed_agents_agent 
  ON managed_agents(agent_id);
```

#### 测试用例

- [ ] ✅ 纳管成功 → 配置写入正确，状态更新
- [ ] ✅ 纳管失败（配置文件只读）→ 返回错误
- [ ] ✅ 重复纳管 → 更新现有配置
- [ ] ✅ 还原成功 → 移除配置，状态更新
- [ ] ✅ 还原后重新纳管 → 复用 route_id

---

### 1.3 流量识别与统计

#### 文件：`client/electron/local-gateway.js`

- [ ] **增强 `detectAppFromRequest()` 函数**
  - [ ] 检测 User-Agent 包含 'aionui'
  - [ ] 检测 User-Agent 包含 'electron-aionui'
  - [ ] 检测 API Key 前缀：`tb-aionui-`
  - [ ] 从 API Key 反查 agent_id
  - [ ] 返回 'aionui-desktop' 或 'aionui-webui'
  
- [ ] **新增助手类型提取逻辑**
  - [ ] 从请求上下文提取 `x-aionui-assistant` header
  - [ ] 从消息内容推断（关键词匹配）
  - [ ] 默认值：'unknown'

```javascript
// 增强后的请求识别
function detectAppFromRequest(req) {
  const ua = req.headers['user-agent'] || '';
  const apiKey = extractApiKey(req);
  const assistantHeader = req.headers['x-aionui-assistant'];
  
  // 1. 通过 UA 识别
  if (ua.includes('aionui') || ua.includes('electron-aionui')) {
    return {
      appId: 'aionui-desktop',
      assistant: assistantHeader || inferAssistantFromContent(req.body)
    };
  }
  
  // 2. 通过 API Key 识别
  if (apiKey && apiKey.startsWith('tb-aionui-')) {
    return {
      appId: 'aionui-desktop',
      assistant: assistantHeader || 'unknown'
    };
  }
  
  // 3. 回退到现有逻辑
  return detectOtherAgents(req);
}

// 从消息内容推断助手类型
function inferAssistantFromContent(body) {
  const systemMsg = body.messages?.find(m => m.role === 'system')?.content || '';
  
  if (systemMsg.includes('PPT') || systemMsg.includes('presentation')) {
    return 'PPT Creator';
  }
  if (systemMsg.includes('Word') || systemMsg.includes('document')) {
    return 'Word Creator';
  }
  if (systemMsg.includes('Excel') || systemMsg.includes('spreadsheet')) {
    return 'Excel Creator';
  }
  if (systemMsg.includes('Cowork')) {
    return 'Cowork';
  }
  
  return 'unknown';
}
```

#### 数据库扩展

- [ ] **扩展 `local_stats` 表**

```sql
ALTER TABLE local_stats ADD COLUMN assistant_type TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_local_stats_assistant 
  ON local_stats(assistant_type);
```

#### 测试用例

- [ ] ✅ AionUi 请求正确识别为 'aionui-desktop'
- [ ] ✅ 助手类型正确提取（PPT/Word/Excel/Cowork）
- [ ] ✅ 统计数据正确写入数据库
- [ ] ✅ 混合流量（多个 Agent）正确区分

---

### 1.4 前端界面 - Gateway 页面

#### 文件：`client/src/pages/Gateway.vue`

- [ ] **新增 AionUi 应用卡片组件**
  - [ ] 卡片布局：图标 + 标题 + 版本 + 状态徽章
  - [ ] 实时统计：今日调用、Token 用量、预估成本
  - [ ] 按助手类型细分（饼图或柱状图）
  - [ ] 操作按钮：一键纳管 / 还原
  - [ ] 路由选择下拉框
  - [ ] 加载状态和错误处理

```vue
<template>
  <div class="app-card aionui" v-if="aionuiDetected">
    <!-- 卡片头部 -->
    <div class="app-header">
      <img src="@/assets/icons/aionui.svg" class="app-icon" alt="AionUi" />
      <div class="app-info">
        <h3>AionUi Desktop</h3>
        <p class="version">v{{ aionuiVersion }}</p>
        <p class="path">{{ aionuiPath }}</p>
      </div>
      <div class="status-badge" :class="statusClass">
        <span class="status-dot"></span>
        {{ statusText }}
      </div>
    </div>
    
    <!-- 统计数据（仅纳管后显示）-->
    <div v-if="isTracked" class="app-stats">
      <div class="stat-group">
        <div class="stat-item">
          <span class="stat-label">今日调用</span>
          <span class="stat-value">{{ stats.calls }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Token 用量</span>
          <span class="stat-value">{{ formatTokens(stats.tokens) }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">预估成本</span>
          <span class="stat-value cost">${{ stats.cost.toFixed(3) }}</span>
        </div>
      </div>
      
      <!-- 按助手类型细分 -->
      <div class="assistant-breakdown">
        <h4>按助手类型</h4>
        <div class="assistant-list">
          <div 
            v-for="(data, type) in stats.byAssistant" 
            :key="type"
            class="assistant-row"
          >
            <span class="assistant-icon">{{ getAssistantIcon(type) }}</span>
            <span class="assistant-name">{{ type }}</span>
            <span class="assistant-calls">{{ data.calls }} 次</span>
            <span class="assistant-tokens">{{ formatTokens(data.tokens) }}</span>
            <span class="assistant-cost">${{ data.cost.toFixed(3) }}</span>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 操作区域 -->
    <div class="app-actions">
      <template v-if="status === 'not_tracked'">
        <select v-model="selectedRouteId" class="route-select">
          <option value="">选择路由（可选）</option>
          <option v-for="r in routes" :key="r.id" :value="r.id">
            {{ r.name }}
          </option>
        </select>
        <button 
          @click="handleOnboard"
          :disabled="loading"
          class="btn-primary"
        >
          {{ loading ? '纳管中...' : '一键纳管' }}
        </button>
      </template>
      
      <template v-else-if="status === 'tracked' || status === 'tracked_via_gateway'">
        <select v-model="selectedRouteId" class="route-select">
          <option value="">直连官方</option>
          <option v-for="r in routes" :key="r.id" :value="r.id">
            {{ r.name }}
          </option>
        </select>
        <button 
          @click="handleUpdateRoute"
          :disabled="loading"
          class="btn-secondary"
        >
          更新路由
        </button>
        <button 
          @click="handleRevert"
          :disabled="loading"
          class="btn-warning"
        >
          还原
        </button>
      </template>
    </div>
    
    <!-- 提示信息 -->
    <div v-if="message" class="message" :class="messageType">
      {{ message }}
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

// 状态
const aionuiDetected = ref(false);
const aionuiVersion = ref('');
const aionuiPath = ref('');
const status = ref('not_tracked');
const selectedRouteId = ref('');
const loading = ref(false);
const message = ref('');
const messageType = ref('info');
const stats = ref({
  calls: 0,
  tokens: 0,
  cost: 0,
  byAssistant: {}
});

// 计算属性
const isTracked = computed(() => 
  status.value === 'tracked' || status.value === 'tracked_via_gateway'
);

const statusClass = computed(() => {
  const map = {
    'not_tracked': 'status-idle',
    'tracked': 'status-tracked',
    'tracked_via_gateway': 'status-active',
    'reverted': 'status-reverted'
  };
  return map[status.value] || 'status-idle';
});

const statusText = computed(() => {
  const map = {
    'not_tracked': '未纳管',
    'tracked': '已纳管（直连）',
    'tracked_via_gateway': '已纳管（走网关）',
    'reverted': '已还原'
  };
  return map[status.value] || '未知';
});

// 方法
async function detectAionUi() {
  const result = await window.electronAPI.detectAgent('aionui');
  if (result && result.detected) {
    aionuiDetected.value = true;
    aionuiVersion.value = result.version;
    aionuiPath.value = result.configPath;
    status.value = result.status;
    selectedRouteId.value = result.routeId || '';
  }
}

async function handleOnboard() {
  loading.value = true;
  message.value = '';
  
  try {
    const result = await window.electronAPI.onboardAgent('aionui', {
      routeId: selectedRouteId.value || null
    });
    
    if (result.success) {
      status.value = 'tracked_via_gateway';
      message.value = `✅ 纳管成功！API Key: ${result.apiKey}`;
      messageType.value = 'success';
      await loadStats();
    } else {
      message.value = `❌ 纳管失败：${result.error}`;
      messageType.value = 'error';
    }
  } catch (error) {
    message.value = `❌ 操作失败：${error.message}`;
    messageType.value = 'error';
  } finally {
    loading.value = false;
  }
}

async function handleRevert() {
  loading.value = true;
  message.value = '';
  
  try {
    const result = await window.electronAPI.revertAgent('aionui');
    
    if (result.success) {
      status.value = 'not_tracked';
      message.value = '✅ 已还原 AionUi 原始配置';
      messageType.value = 'success';
      stats.value = { calls: 0, tokens: 0, cost: 0, byAssistant: {} };
    } else {
      message.value = `❌ 还原失败：${result.error}`;
      messageType.value = 'error';
    }
  } catch (error) {
    message.value = `❌ 操作失败：${error.message}`;
    messageType.value = 'error';
  } finally {
    loading.value = false;
  }
}

async function handleUpdateRoute() {
  loading.value = true;
  message.value = '';
  
  try {
    const result = await window.electronAPI.updateAgentRoute('aionui', {
      routeId: selectedRouteId.value || null
    });
    
    if (result.success) {
      message.value = '✅ 路由已更新';
      messageType.value = 'success';
    } else {
      message.value = `❌ 更新失败：${result.error}`;
      messageType.value = 'error';
    }
  } catch (error) {
    message.value = `❌ 操作失败：${error.message}`;
    messageType.value = 'error';
  } finally {
    loading.value = false;
  }
}

async function loadStats() {
  const today = new Date().toISOString().slice(0, 10);
  const result = await window.electronAPI.getAppStats('aionui-desktop', {
    startDate: today,
    endDate: today,
    groupBy: 'assistant_type'
  });
  
  stats.value = result;
}

function getAssistantIcon(type) {
  const icons = {
    'Cowork': '🤝',
    'PPT Creator': '📊',
    'Morph PPT': '✨',
    'Word Creator': '📝',
    'Excel Creator': '📗',
    'Academic Paper Writer': '🎓',
    'Planning with Files': '📋',
    'UI/UX Pro Max': '🎨',
    'unknown': '🤖'
  };
  return icons[type] || '📱';
}

function formatTokens(tokens) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toString();
}

// 生命周期
onMounted(async () => {
  await detectAionUi();
  if (isTracked.value) {
    await loadStats();
    // 每 30 秒刷新统计
    setInterval(loadStats, 30000);
  }
});
</script>

<style scoped>
/* 样式省略，参考现有 app-card 样式 */
</style>
```

#### 测试用例

- [ ] ✅ 未安装 AionUi → 不显示卡片
- [ ] ✅ 已安装未纳管 → 显示"一键纳管"按钮
- [ ] ✅ 已纳管 → 显示统计数据和操作按钮
- [ ] ✅ 纳管操作 → 成功提示，状态更新
- [ ] ✅ 还原操作 → 成功提示，状态更新
- [ ] ✅ 统计数据实时刷新

---

### 1.5 API 端点

#### 文件：`client/electron/main.js` (IPC handlers)

- [ ] **新增 IPC 处理器**

```javascript
ipcMain.handle('detect-agent', async (event, agentId) => {
  if (agentId === 'aionui') {
    return await detectAionUi();
  }
  // 其他 agent 检测逻辑
});

ipcMain.handle('onboard-agent', async (event, agentId, config) => {
  if (agentId === 'aionui') {
    return await onboardAionUi(config);
  }
  // 其他 agent 纳管逻辑
});

ipcMain.handle('revert-agent', async (event, agentId) => {
  if (agentId === 'aionui') {
    return await revertAionUi();
  }
  // 其他 agent 还原逻辑
});

ipcMain.handle('update-agent-route', async (event, agentId, config) => {
  if (agentId === 'aionui') {
    return await updateAionUiRoute(config);
  }
  // 其他 agent 路由更新逻辑
});

ipcMain.handle('get-app-stats', async (event, appId, options) => {
  return await getAppStats(appId, options);
});
```

#### 文件：`client/electron/preload.js`

- [ ] **暴露 API 到渲染进程**

```javascript
contextBridge.exposeInMainWorld('electronAPI', {
  // 现有 API
  // ...
  
  // 新增 AionUi 相关 API
  detectAgent: (agentId) => ipcRenderer.invoke('detect-agent', agentId),
  onboardAgent: (agentId, config) => ipcRenderer.invoke('onboard-agent', agentId, config),
  revertAgent: (agentId) => ipcRenderer.invoke('revert-agent', agentId),
  updateAgentRoute: (agentId, config) => ipcRenderer.invoke('update-agent-route', agentId, config),
  getAppStats: (appId, options) => ipcRenderer.invoke('get-app-stats', appId, options)
});
```

---

## ✅ 阶段二：深度整合（预计 2-3 周）

### 2.1 Session Manager 集成

#### 文件：`client/electron/session-browser.js`

- [ ] **新增 `listAionUiSessions()` 函数**
  - [ ] 打开 SQLite 数据库：`~/.aionui/database.db`
  - [ ] 查询 `conversations` 表
  - [ ] 连接 `messages` 表统计信息
  - [ ] 提取项目路径（workspace_path）
  - [ ] 提取助手类型（assistant_type）
  - [ ] 格式化为标准 session 对象
  - [ ] 处理错误（数据库不存在、格式变更）

```javascript
export async function listAionUiSessions(options = {}) {
  const dbPath = path.join(os.homedir(), '.aionui/database.db');
  
  if (!await fs.pathExists(dbPath)) {
    return [];
  }
  
  try {
    const db = await sqlite.open({
      filename: dbPath,
      driver: sqlite3.Database
    });
    
    // 查询会话列表
    const sessions = await db.all(`
      SELECT 
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
        c.workspace_path,
        c.assistant_type,
        c.model_used,
        COUNT(m.id) as message_count,
        SUM(m.tokens_input) as total_input_tokens,
        SUM(m.tokens_output) as total_output_tokens
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.deleted_at IS NULL
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT ?
    `, options.limit || 100);
    
    await db.close();
    
    // 转换为标准格式
    return sessions.map(s => ({
      agentId: 'aionui',
      sessionId: s.id,
      title: s.title || 'Untitled Conversation',
      project: s.workspace_path ? path.basename(s.workspace_path) : null,
      cwd: s.workspace_path,
      createdAt: new Date(s.created_at).toISOString(),
      updatedAt: new Date(s.updated_at).toISOString(),
      messageCount: s.message_count,
      totalTokens: (s.total_input_tokens || 0) + (s.total_output_tokens || 0),
      assistantType: s.assistant_type,
      model: s.model_used,
      source: 'aionui-db'
    }));
    
  } catch (error) {
    console.error('Failed to read AionUi sessions:', error);
    return [];
  }
}
```

- [ ] **新增 `getAionUiTrace(sessionId)` 函数**
  - [ ] 查询完整消息历史
  - [ ] 解析 tool_calls（JSON）
  - [ ] 解析 attachments（JSON）
  - [ ] 构建 trace 对象（messages + stats）
  - [ ] 支持文件引用解析

```javascript
export async function getAionUiTrace(sessionId) {
  const dbPath = path.join(os.homedir(), '.aionui/database.db');
  const db = await sqlite.open({ filename: dbPath, driver: sqlite3.Database });
  
  // 查询会话信息
  const session = await db.get(`
    SELECT * FROM conversations WHERE id = ?
  `, sessionId);
  
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  
  // 查询消息列表
  const messages = await db.all(`
    SELECT 
      id,
      role,
      content,
      created_at,
      tokens_input,
      tokens_output,
      model_used,
      tool_calls,
      attachments,
      status
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `, sessionId);
  
  await db.close();
  
  // 转换为标准 trace 格式
  const trace = {
    sessionId,
    agentId: 'aionui',
    title: session.title,
    project: session.workspace_path ? path.basename(session.workspace_path) : null,
    cwd: session.workspace_path,
    assistantType: session.assistant_type,
    createdAt: new Date(session.created_at).toISOString(),
    updatedAt: new Date(session.updated_at).toISOString(),
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: new Date(m.created_at).toISOString(),
      tokens: {
        input: m.tokens_input || 0,
        output: m.tokens_output || 0,
        total: (m.tokens_input || 0) + (m.tokens_output || 0)
      },
      model: m.model_used,
      toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : [],
      attachments: m.attachments ? JSON.parse(m.attachments) : [],
      status: m.status
    })),
    stats: null  // 稍后计算
  };
  
  // 计算统计信息
  trace.stats = buildTraceStats(trace.messages);
  
  return trace;
}
```

- [ ] **修改 `listAllSessions()` 聚合函数**

```javascript
export async function listAllSessions(options = {}) {
  const results = await Promise.all([
    listClaudeSessions(options),
    listCodexSessions(options),
    listCursorSessions(options),
    listAionUiSessions(options),  // 新增
    // 其他 agent sessions
  ]);
  
  const allSessions = results.flat();
  
  // 按更新时间排序
  allSessions.sort((a, b) => 
    new Date(b.updatedAt) - new Date(a.updatedAt)
  );
  
  return allSessions;
}
```

#### 测试用例

- [ ] ✅ 读取 AionUi 会话列表
- [ ] ✅ 获取单个会话详情
- [ ] ✅ 助手类型正确识别
- [ ] ✅ Token 统计准确
- [ ] ✅ 文件附件正确解析
- [ ] ✅ 数据库不存在时不报错

---

### 2.2 Handoff 支持

#### 文件：`client/electron/session-manager.js`

- [ ] **修改 `continueSession()` 支持 AionUi 作为目标**
  - [ ] 启动 AionUi（macOS: `open -a AionUi`）
  - [ ] 写 handoff 文档到 AionUi 工作区
  - [ ] 创建新会话（通过 IPC 或文件约定）
  - [ ] 复制 handoff 内容到剪贴板
  - [ ] 显示提示信息

```javascript
export async function continueSession(sessionId, targetAgent, options = {}) {
  // 1. 生成 handoff 文档
  const handoffDoc = await composeHandoffDoc(sessionId, targetAgent);
  
  // 2. 根据目标 agent 执行不同操作
  if (targetAgent === 'aionui') {
    return await handoffToAionUi(sessionId, handoffDoc, options);
  } else {
    // 现有逻辑（claude-code / codex 等）
    return await handoffToCliAgent(targetAgent, handoffDoc, options);
  }
}

async function handoffToAionUi(sessionId, handoffDoc, options) {
  const handoffPath = path.join(
    os.homedir(),
    '.tokenbank/handoffs',
    `${sessionId}-to-aionui-${Date.now()}.md`
  );
  
  await fs.ensureDir(path.dirname(handoffPath));
  await fs.writeFile(handoffPath, handoffDoc, 'utf8');
  
  // 启动 AionUi
  const platform = process.platform;
  if (platform === 'darwin') {
    await exec('open -a AionUi');
  } else if (platform === 'win32') {
    await exec('start "" "AionUi"');
  } else {
    // Linux - 尝试常见的可执行文件名
    try {
      await exec('aionui &');
    } catch (e) {
      console.warn('Failed to auto-start AionUi on Linux');
    }
  }
  
  // 复制到剪贴板
  await clipboard.writeText(handoffDoc);
  
  return {
    success: true,
    handoffPath,
    message: 'AionUi 已启动，交接文档已复制到剪贴板。请粘贴到 AionUi 开始续聊。'
  };
}
```

#### 测试用例

- [ ] ✅ Handoff 文档正确生成
- [ ] ✅ AionUi 自动启动（Mac/Win）
- [ ] ✅ 剪贴板包含 handoff 内容
- [ ] ✅ 提示信息清晰

---

### 2.3 知识提炼集成

#### 文件：`client/electron/session-manager.js`

- [ ] **修改 `synthesizeKnowledge()` 包含 AionUi 会话**
  - [ ] 从 AionUi 会话提取 user 消息
  - [ ] 应用噪声过滤（`learn-mine.js`）
  - [ ] 标注助手类型（Office/Cowork/Planning）
  - [ ] 按项目聚合
  - [ ] 合成知识时区分来源

```javascript
export async function synthesizeKnowledge(options = {}) {
  // 1. 收集所有会话
  const allSessions = await listAllSessions({ includeArchived: false });
  
  // 2. 构建语料库（包含 AionUi）
  const corpus = await buildKnowledgeCorpus(allSessions, {
    includeAgents: ['claude-code', 'codex', 'cursor', 'aionui'],  // 新增
    ...options
  });
  
  // 3. 按来源标注
  const annotatedCorpus = corpus.map(item => ({
    ...item,
    sourceAgent: item.agentId,
    assistantType: item.assistantType || null,  // AionUi 独有
    weight: calculateWeight(item)  // Office 文档生成可能权重更高
  }));
  
  // 4. 合成知识
  const knowledge = await synthesizeViaGateway(annotatedCorpus, options);
  
  // 5. 写入 AGENTS.md
  const agentsPath = path.join(process.cwd(), 'AGENTS.md');
  await fs.writeFile(agentsPath, knowledge, 'utf8');
  
  return {
    success: true,
    path: agentsPath,
    sessionCount: allSessions.length,
    agentBreakdown: countByAgent(allSessions)
  };
}

function calculateWeight(item) {
  // Office 文档生成类会话权重更高（可能包含关键业务逻辑）
  if (item.agentId === 'aionui') {
    const officeTypes = ['PPT Creator', 'Word Creator', 'Excel Creator', 'Academic Paper Writer'];
    if (officeTypes.includes(item.assistantType)) {
      return 1.5;
    }
  }
  return 1.0;
}
```

#### 测试用例

- [ ] ✅ AionUi 会话包含在语料库中
- [ ] ✅ 助手类型正确标注
- [ ] ✅ Office 会话权重更高
- [ ] ✅ AGENTS.md 包含 AionUi 来源说明

---

### 2.4 Dashboard 增强

#### 文件：`client/src/pages/Dashboard.vue`

- [ ] **新增「热门助手」统计模块**
  - [ ] 查询 AionUi 助手类型统计
  - [ ] 柱状图展示（调用次数 + 成本）
  - [ ] 图标映射（PPT/Word/Excel/Cowork）
  - [ ] 点击跳转到详细日志

```vue
<template>
  <div class="dashboard-page">
    <!-- 现有模块 -->
    
    <!-- 新增：热门助手（AionUi）-->
    <div class="stats-section assistant-stats" v-if="hasAionUiData">
      <div class="section-header">
        <h3>
          <span class="icon">🤖</span>
          热门助手（AionUi）
        </h3>
        <span class="subtitle">按助手类型统计</span>
      </div>
      
      <div class="assistant-chart">
        <div 
          v-for="a in topAssistants" 
          :key="a.type"
          class="assistant-bar"
          @click="viewAssistantDetail(a.type)"
        >
          <div class="bar-label">
            <span class="assistant-icon">{{ a.icon }}</span>
            <span class="assistant-name">{{ a.name }}</span>
          </div>
          <div class="bar-container">
            <div 
              class="bar-fill"
              :style="{ 
                width: (a.calls / maxAssistantCalls * 100) + '%',
                backgroundColor: a.color 
              }"
            ></div>
          </div>
          <div class="bar-stats">
            <span class="bar-calls">{{ a.calls }} 次</span>
            <span class="bar-cost">${{ a.cost.toFixed(3) }}</span>
          </div>
        </div>
      </div>
      
      <!-- 趋势图（可选）-->
      <div class="assistant-trend">
        <canvas ref="assistantTrendChart"></canvas>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import Chart from 'chart.js/auto';

const topAssistants = ref([]);
const hasAionUiData = ref(false);
const maxAssistantCalls = computed(() => 
  Math.max(...topAssistants.value.map(a => a.calls), 1)
);

async function loadAssistantStats() {
  const stats = await window.electronAPI.getAssistantStats({
    period: 'today',
    limit: 10
  });
  
  if (stats && stats.length > 0) {
    hasAionUiData.value = true;
    topAssistants.value = stats.map(s => ({
      type: s.assistant_type,
      name: s.assistant_type || 'Unknown',
      icon: getAssistantIcon(s.assistant_type),
      color: getAssistantColor(s.assistant_type),
      calls: s.total_calls,
      tokens: s.total_tokens,
      cost: s.total_cost
    }));
  }
}

function getAssistantIcon(type) {
  const icons = {
    'Cowork': '🤝',
    'PPT Creator': '📊',
    'Morph PPT': '✨',
    'Morph PPT 3D': '🎭',
    'Word Creator': '📝',
    'Word Form Creator': '📋',
    'Excel Creator': '📗',
    'Academic Paper Writer': '🎓',
    'Financial Model Creator': '💰',
    '3D Game': '🎮',
    'UI/UX Pro Max': '🎨',
    'Planning with Files': '📁',
    'Story Roleplay': '📖'
  };
  return icons[type] || '🤖';
}

function getAssistantColor(type) {
  const colors = {
    'Cowork': '#10b981',
    'PPT Creator': '#3b82f6',
    'Word Creator': '#8b5cf6',
    'Excel Creator': '#22c55e',
    'Academic Paper Writer': '#f59e0b'
  };
  return colors[type] || '#6b7280';
}

function viewAssistantDetail(type) {
  // 跳转到 Gateway 页面，筛选该助手类型的日志
  window.electronAPI.navigateTo('gateway', { 
    filter: { assistant_type: type } 
  });
}

onMounted(async () => {
  await loadAssistantStats();
});
</script>
```

#### 新增 API 端点

```javascript
// main.js IPC handler
ipcMain.handle('get-assistant-stats', async (event, options) => {
  const { period, limit } = options;
  
  // 查询数据库
  const stats = await db.all(`
    SELECT 
      assistant_type,
      COUNT(*) as total_calls,
      SUM(tokens_input + tokens_output) as total_tokens,
      SUM(cost_usd) as total_cost
    FROM local_stats
    WHERE 
      app_id = 'aionui-desktop' 
      AND assistant_type IS NOT NULL
      AND timestamp >= ?
    GROUP BY assistant_type
    ORDER BY total_calls DESC
    LIMIT ?
  `, [getTimestampForPeriod(period), limit || 10]);
  
  return stats;
});
```

#### 测试用例

- [ ] ✅ 有 AionUi 数据时显示模块
- [ ] ✅ 无数据时隐藏模块
- [ ] ✅ 柱状图正确渲染
- [ ] ✅ 点击跳转到详细日志

---

## ✅ 阶段三：体验优化（预计 1-2 周）

### 3.1 文档编写

#### 文件：`docs/integration/aionui.md`

- [ ] **编写完整的集成指南**
  - [ ] 概述和价值说明
  - [ ] 前置条件
  - [ ] 一键集成步骤（带截图）
  - [ ] 手动配置步骤（备选方案）
  - [ ] 功能特性说明
  - [ ] 统计查看指南
  - [ ] 高级用法（场景路由、Session 导出、Handoff）
  - [ ] 故障排除
  - [ ] 最佳实践
  - [ ] 常见问题 FAQ

#### 文件：`README.md`

- [ ] **更新主 README**
  - [ ] 在「核心能力」章节添加 AionUi 集成说明
  - [ ] 在「支持的应用」列表添加 AionUi
  - [ ] 添加「与 AionUi 配合使用」专题链接

---

### 3.2 视频教程

- [ ] **录制演示视频**
  - [ ] 安装 Token Bank 和 AionUi
  - [ ] 一键纳管操作演示
  - [ ] 使用 AionUi Office 助手（PPT/Word/Excel）
  - [ ] 查看成本统计和路由结果
  - [ ] Session 导出和 Handoff 演示
  - [ ] 上传到 YouTube / Bilibili
  - [ ] 在文档中嵌入视频链接

---

### 3.3 示例和模板

- [ ] **创建配置示例**
  - [ ] `examples/aionui-config.json`：完整配置示例
  - [ ] `examples/aionui-routes.yaml`：场景路由配置
  - [ ] `examples/aionui-handoff.md`：Handoff 文档模板

---

### 3.4 社区推广

- [ ] **发布博客文章**
  - [ ] 标题：「AionUi + Token Bank：全栈 AI 工作流平台」
  - [ ] 介绍两个项目的互补性
  - [ ] 展示集成步骤和效果
  - [ ] 分享成本优化案例

- [ ] **GitHub 互相推荐**
  - [ ] Token Bank README 添加 AionUi 链接
  - [ ] 联系 AionUi 项目，建议在其文档中推荐 Token Bank

- [ ] **社交媒体宣传**
  - [ ] Twitter/X 发布集成公告
  - [ ] Reddit r/LocalLLaMA 分享
  - [ ] Discord / Telegram 社区讨论

---

## 🧪 测试计划

### 单元测试

- [ ] `detectAionUi()` 函数测试
- [ ] `onboardAionUi()` 配置修改测试
- [ ] `revertAionUi()` 还原测试
- [ ] `listAionUiSessions()` 数据库读取测试
- [ ] `getAionUiTrace()` trace 构建测试
- [ ] Session 聚合测试

### 集成测试

- [ ] 完整纳管流程测试（检测 → 纳管 → 使用 → 还原）
- [ ] AionUi 请求经过 Token Bank 网关
- [ ] 统计数据正确记录到数据库
- [ ] Dashboard 正确显示 AionUi 数据
- [ ] Handoff 到 AionUi 功能测试

### 性能测试

- [ ] 网关延迟测试（< 10ms）
- [ ] 数据库读取性能（session 列表 < 200ms）
- [ ] 前端渲染性能（Dashboard 加载 < 1s）

### 兼容性测试

- [ ] macOS 10.15+
- [ ] Windows 10+
- [ ] Linux (Ubuntu 20.04+)
- [ ] AionUi 多个版本（1.4.x / 1.5.x）

---

## 📦 交付物清单

### 代码修改

- [x] `client/electron/detect-tools.js`
- [x] `client/electron/agent-linker.js`
- [x] `client/electron/local-gateway.js`
- [x] `client/electron/session-browser.js`
- [x] `client/electron/session-manager.js`
- [x] `client/electron/main.js` (IPC handlers)
- [x] `client/electron/preload.js`
- [x] `client/src/pages/Gateway.vue`
- [x] `client/src/pages/Dashboard.vue`

### 数据库 Schema

- [x] `managed_agents` 表
- [x] `aionui_sessions` 表
- [x] `local_stats` 表扩展（`assistant_type` 字段）

### 文档

- [x] `docs/integration/aionui.md`（完整集成指南）
- [x] `docs/aionui-integration-analysis.md`（方案分析）
- [x] `docs/aionui-integration-quick-guide.md`（快速指南）
- [x] 更新 `README.md`

### 示例

- [x] `examples/aionui-config.json`
- [x] `examples/aionui-routes.yaml`
- [x] `examples/aionui-handoff.md`

### 测试

- [x] 单元测试套件
- [x] 集成测试套件
- [x] 性能测试报告

### 推广

- [x] 博客文章
- [x] 视频教程
- [x] 社交媒体发布

---

## 📅 时间线

| 阶段 | 任务 | 预计时间 | 负责人 |
|-----|------|---------|-------|
| 阶段一 | 基础集成（检测、纳管、统计）| 1-2 周 | TBD |
| 阶段二 | 深度整合（Session、Handoff、Dashboard）| 2-3 周 | TBD |
| 阶段三 | 体验优化（文档、视频、推广）| 1-2 周 | TBD |
| 测试 | 单元 + 集成 + 性能测试 | 1 周 | TBD |
| 发布 | 版本发布和社区推广 | 持续 | TBD |

**总计：5-8 周**

---

## 🎯 成功标准

### 技术指标

- [x] AionUi 检测准确率 > 95%
- [x] 一键纳管成功率 > 90%
- [x] Session 导入完整性 > 98%
- [x] 网关延迟增加 < 10ms
- [x] 统计数据准确率 100%

### 用户指标

- [x] 集成后 7 天留存率 > 80%
- [x] 用户反馈满意度 > 4.5/5
- [x] 平均 LLM 成本下降 30-50%

### 社区指标

- [x] 集成文档浏览量 > 1000
- [x] 视频观看量 > 500
- [x] GitHub 讨论/Issue 反馈 > 20 条

---

_技术实施清单版本：v1.0 | 2026-07-05_
