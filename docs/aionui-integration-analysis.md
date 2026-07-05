# AionUi 与 Token Bank 集成方案调研报告

> 调研日期：2026-07-05  
> 状态：方案分析阶段

---

## 一、项目概况对比

### 1.1 Token Bank（当前项目）

**定位**：本地 LLM 网关 + Token 管理器

**核心能力**：
- 🔌 **网关代理**：统一入口（`localhost:11430`），多协议支持（OpenAI/Anthropic/Gemini）
- 📊 **用量追踪**：实时代理 + 会话导入双轨制，全链路 Trace
- 💰 **成本管理**：订阅摊销 + PAYG 估算，多维度统计分析
- 🔀 **智能路由**：本地源 → 免费 API → P2P → 付费 API 降级链
- 🤝 **Agent 纳管**：支持 Cursor、Claude Code、Codex 等主流工具
- 🌐 **P2P 网络**：贡献算力赚积分，消费社区模型

**技术栈**：
- 前端：Electron + Vue 3
- 后端：Node.js（网关）+ Python FastAPI（P2P 服务端）
- 数据库：SQLite
- 部署：桌面应用（Mac/Win）+ CLI + Docker

### 1.2 AionUi

**定位**：免费开源的 AI Agent Cowork 平台

**核心能力**：
- 🤖 **内置 Agent 引擎**：零配置，开箱即用
- 🔗 **多 Agent 集成**：支持 20+ CLI Agent（Claude Code、Codex、Hermes Agent 等）
- 🌍 **30+ LLM 平台**：Gemini、OpenAI、Anthropic、AWS Bedrock、Ollama 等
- 🌐 **远程访问**：WebUI + Telegram/Lark/钉钉/微信 Bot
- ⏰ **定时任务**：Cron 调度，24/7 无人值守
- 👥 **团队协作**：Leader-Teammate 模式，并行多 Agent 执行
- 📄 **Office 助手**：PPT（Morph 动画）、Word、Excel 生成
- 🔍 **文件预览**：10+ 格式即时预览（PDF/Word/Excel/PPT/代码）
- 🎨 **可扩展**：自定义助手 + 三层技能系统（内置/自定义/扩展）

**技术栈**：
- 前端：Electron + Bun + TypeScript
- 后端：AionCore（本地后端）+ Aion CLI（aionrs，Rust）
- 部署：桌面应用（Mac/Win/Linux）+ WebUI 服务器模式

---

## 二、互补性分析

### 2.1 Token Bank 的优势
✅ **成本可见性**：精确到每次调用的 token/成本追踪  
✅ **智能路由**：供给链优化，自动降级到最优源  
✅ **订阅管理**：统一管理 APP/API 订阅 + PAYG  
✅ **P2P 网络**：闲置算力变现，社区共享模型  
✅ **多设备聚合**：跨设备用量云端同步  

### 2.2 AionUi 的优势
✅ **内置 Agent**：无需额外安装 CLI 工具  
✅ **丰富场景**：Office 文档生成、定时任务、远程访问  
✅ **团队协作**：多 Agent 并行协作模式  
✅ **用户体验**：文件预览、助手系统、Bot 集成  
✅ **跨平台**：完整的 Linux 支持  

### 2.3 结合价值
🎯 **Token Bank + AionUi 能力互补**：
- Token Bank 提供**成本控制和智能路由**
- AionUi 提供**丰富的应用场景和用户体验**
- 形成**全栈 AI 工作流平台**：从成本管理到任务执行

---

## 三、集成方案设计

### 3.1 方案一：AionUi 作为 Token Bank 的前置 Agent（推荐 ⭐）

**架构**：
```
用户交互层
    │
    ├─ AionUi Desktop/WebUI（用户界面 + Agent 引擎）
    │
    ▼
Token Bank Gateway（localhost:11430）
    │
    ├─ 智能路由引擎
    ├─ 成本追踪
    ├─ 供给源管理
    │
    ▼
LLM 供给层
    ├─ 本地源（Ollama）
    ├─ 免费 API（Groq/GitHub Models）
    ├─ P2P 网络
    └─ 付费 API（OpenAI/Anthropic/Gemini）
```

**实施步骤**：

1. **AionUi 配置 Token Bank 网关**
   - 在 AionUi 的 LLM 配置中添加 Custom 平台
   - Base URL 指向 `http://localhost:11430/v1`
   - API Key 使用 Token Bank 生成的本地 Key
   
2. **Token Bank 识别 AionUi 流量**
   - 在 `detect-tools.js` 添加 AionUi 检测逻辑
   - 为 AionUi 创建专属 `app_id`（如 `aionui-desktop` / `aionui-webui`）
   - 支持 AionUi 的 User-Agent 识别

3. **统一纳管面板**
   - Token Bank Gateway 页面添加 AionUi 卡片
   - 一键纳管：自动配置 AionUi 的 LLM 设置
   - 显示 AionUi 的用量统计：Office 文档生成、定时任务执行等

4. **Session 互通**
   - Token Bank 读取 AionUi 的会话数据（`~/.aionui/`）
   - 支持从 Token Bank Session Manager 导出 AionUi 格式
   - Handoff 功能支持 AionUi 作为目标 Agent

**优势**：
- ✅ 最小侵入性，无需修改 AionUi 核心代码
- ✅ 保留两个项目的独立性
- ✅ 用户可单独使用任一项目
- ✅ Token Bank 获得丰富的上层应用场景
- ✅ AionUi 获得智能路由和成本控制能力

**技术要点**：
```javascript
// 1. Token Bank - detect-tools.js 新增检测
export async function detectAionUi() {
  const aionuiPaths = [
    path.join(os.homedir(), '.aionui'),
    path.join(os.homedir(), 'Library/Application Support/aionui'),
    path.join(os.homedir(), 'AppData/Roaming/aionui')
  ];
  
  for (const p of aionuiPaths) {
    if (await fs.pathExists(p)) {
      return {
        id: 'aionui-desktop',
        name: 'AionUi Desktop',
        detected: true,
        version: await getAionUiVersion(p),
        configPath: path.join(p, 'config.json')
      };
    }
  }
  return null;
}

// 2. 一键纳管 - 自动配置 AionUi
export async function onboardAionUi(routeId) {
  const configPath = path.join(os.homedir(), '.aionui/config.json');
  const config = await fs.readJson(configPath);
  
  // 添加 Token Bank Gateway 作为 Custom LLM
  config.llmPlatforms = config.llmPlatforms || [];
  config.llmPlatforms.push({
    type: 'custom',
    name: 'Token Bank Gateway',
    baseUrl: 'http://localhost:11430/v1',
    apiKey: await generateLocalKey('aionui'),
    models: ['gpt-4o', 'claude-sonnet-4-6', 'gemini-2.0-flash-exp']
  });
  
  await fs.writeJson(configPath, config, { spaces: 2 });
  return { success: true };
}

// 3. Session 导入 - session-browser.js 新增
export async function listAionUiSessions() {
  const aionuiDb = path.join(os.homedir(), '.aionui/database.db');
  // 读取 AionUi SQLite 数据库
  // 解析会话、消息、文件操作记录
  // 返回标准化的 session 列表
}
```

---

### 3.2 方案二：深度集成（Token Bank UI 嵌入 AionUi 功能）

**架构**：
```
Token Bank Desktop
    │
    ├─ 现有功能（Dashboard/Gateway/Providers/Profile）
    │
    ├─ 新增 Cowork 页面（集成 AionUi 核心功能）
    │   ├─ Agent Chat（内置 Agent 引擎）
    │   ├─ Office 助手（PPT/Word/Excel）
    │   ├─ 定时任务管理
    │   ├─ 文件预览面板
    │   └─ Team 协作模式
    │
    └─ WebUI 扩展（远程访问 + Bot 集成）
```

**实施步骤**：

1. **抽取 AionUi 核心模块**
   - Agent 引擎：`packages/web-cli` + `packages/shared-scripts`
   - Office CLI 集成：`OfficeCLI` 工具链
   - MCP 工具管理
   - 文件预览组件

2. **Token Bank 项目结构调整**
   ```
   client/
   ├── electron/
   │   ├── local-gateway.js          # 现有网关
   │   ├── aionui-core/              # AionUi 核心功能
   │   │   ├── agent-engine.js       # Agent 引擎
   │   │   ├── office-tools.js       # Office 工具集成
   │   │   └── scheduler.js          # 定时任务
   │   └── ...
   ├── src/
   │   ├── pages/
   │   │   ├── Cowork.vue            # 新增 Cowork 页面
   │   │   ├── Assistants.vue        # 助手管理
   │   │   └── ...
   │   └── components/
   │       ├── AgentChat.vue         # Agent 聊天组件
   │       ├── FilePreview.vue       # 文件预览
   │       └── ...
   ```

3. **功能整合**
   - Agent Chat 使用 Token Bank 的路由引擎
   - 所有 LLM 请求经过 `local-gateway.js` 统一处理
   - 用量自动记录到 `local-stats.db`
   - Office 文档生成记录关联到具体会话

4. **UI 统一**
   - 保持 Token Bank 的 Raycast 风格（zinc 调色）
   - 新增 Cowork 导航项
   - Session Manager 扩展支持 AionUi 会话类型

**优势**：
- ✅ 用户体验统一，一个应用完成所有工作
- ✅ 数据深度整合，成本追踪更精细
- ✅ 品牌统一，产品定位清晰

**挑战**：
- ⚠️ 开发工作量大，需要重构 AionUi 核心代码
- ⚠️ 维护复杂度高，需要同步两个代码库的更新
- ⚠️ 可能存在技术栈冲突（Electron 版本、依赖库）

---

### 3.3 方案三：产品矩阵（保持独立，互相推荐）

**策略**：
- Token Bank 和 AionUi 作为独立产品
- 在各自文档中互相推荐
- 提供配置指南和最佳实践

**实施**：

1. **Token Bank 侧**
   - README 添加「与 AionUi 配合使用」章节
   - 提供一键配置脚本
   - 示例：使用 AionUi 作为主力 Agent，Token Bank 管理成本

2. **AionUi 侧**（需要与 AionUi 项目协调）
   - 文档添加「使用 Token Bank 优化成本」指南
   - 在 LLM 配置界面提示可接入本地网关

**优势**：
- ✅ 零开发工作量
- ✅ 保持项目独立性
- ✅ 用户自由选择集成深度

**局限**：
- ⚠️ 集成体验不够流畅
- ⚠️ 需要用户手动配置
- ⚠️ 产品价值传递不够直接

---

## 四、推荐方案与实施路径

### 4.1 推荐采用：方案一（AionUi 作为前置 Agent）

**理由**：
1. **最小风险**：无需修改 AionUi 代码，降低维护成本
2. **快速落地**：2-3 周可完成基础集成
3. **用户友好**：保持两个产品的独立性，用户可按需组合
4. **价值明确**：Token Bank 获得丰富应用场景，AionUi 获得成本控制

### 4.2 三阶段实施路径

**阶段一：基础集成（1-2 周）**
- [ ] Token Bank 添加 AionUi 检测逻辑
- [ ] 实现一键纳管功能（自动配置 AionUi 指向网关）
- [ ] Gateway 页面展示 AionUi 用量统计
- [ ] 测试验证：Office 文档生成、定时任务的成本追踪

**阶段二：深度整合（2-3 周）**
- [ ] Session Manager 读取 AionUi 会话数据
- [ ] Handoff 支持 AionUi 作为目标 Agent
- [ ] 知识提炼包含 AionUi 会话内容
- [ ] Dashboard 支持按助手类型（Office/代码/聊天）细分统计

**阶段三：体验优化（1-2 周）**
- [ ] 编写详细的集成文档和视频教程
- [ ] 提供配置模板和最佳实践
- [ ] 社区推广：展示成本优化案例
- [ ] 收集反馈，持续迭代

**总计：4-7 周完成完整集成**

---

## 五、技术实施清单

### 5.1 Token Bank 侧修改

#### 文件：`client/electron/detect-tools.js`
```javascript
// 新增 AionUi 检测
export async function detectAionUi() {
  // 检测 AionUi 安装
  // 返回版本、配置路径
}

// 修改主检测函数
export async function detectInstalledTools() {
  const tools = await Promise.all([
    detectClaudeCode(),
    detectCodex(),
    detectCursor(),
    detectAionUi(),  // 新增
    // ...
  ]);
  return tools.filter(Boolean);
}
```

#### 文件：`client/electron/agent-linker.js`
```javascript
// 新增 AionUi 纳管逻辑
export async function onboardAionUi(config) {
  const { routeId } = config;
  
  // 1. 生成本地 API Key
  const apiKey = await generateLocalKey('aionui');
  
  // 2. 修改 AionUi 配置文件
  const aionuiConfigPath = path.join(
    os.homedir(), 
    '.aionui/config.json'
  );
  const aionuiConfig = await fs.readJson(aionuiConfigPath);
  
  // 添加 Token Bank Gateway 作为 LLM 平台
  aionuiConfig.llmPlatforms = aionuiConfig.llmPlatforms || [];
  aionuiConfig.llmPlatforms.push({
    type: 'custom',
    name: 'Token Bank Gateway',
    baseUrl: 'http://localhost:11430/v1',
    apiKey,
    models: await getAvailableModels(routeId),
    enabled: true
  });
  
  await fs.writeJson(aionuiConfigPath, aionuiConfig, { spaces: 2 });
  
  // 3. 记录纳管状态
  await updateAgentStatus('aionui', 'tracked', { routeId });
  
  return { success: true, apiKey };
}

// 还原 AionUi 配置
export async function revertAionUi() {
  const configPath = path.join(os.homedir(), '.aionui/config.json');
  const config = await fs.readJson(configPath);
  
  // 移除 Token Bank Gateway 配置
  config.llmPlatforms = config.llmPlatforms.filter(
    p => p.name !== 'Token Bank Gateway'
  );
  
  await fs.writeJson(configPath, config, { spaces: 2 });
  await updateAgentStatus('aionui', 'reverted');
  
  return { success: true };
}
```

#### 文件：`client/electron/session-browser.js`
```javascript
// 新增 AionUi 会话读取
export async function listAionUiSessions() {
  const dbPath = path.join(os.homedir(), '.aionui/database.db');
  
  if (!await fs.pathExists(dbPath)) {
    return [];
  }
  
  const db = await sqlite.open({ filename: dbPath, driver: sqlite3.Database });
  
  // 读取会话列表
  const sessions = await db.all(`
    SELECT 
      id,
      title,
      created_at,
      updated_at,
      workspace_path,
      assistant_type
    FROM conversations
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
  `);
  
  return sessions.map(s => ({
    agentId: 'aionui',
    sessionId: s.id,
    title: s.title || 'Untitled',
    project: path.basename(s.workspace_path || ''),
    cwd: s.workspace_path,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    assistantType: s.assistant_type,  // PPT/Word/Excel/Cowork 等
    source: 'aionui-db'
  }));
}

// 获取 AionUi 会话详情
export async function getAionUiTrace(sessionId) {
  const dbPath = path.join(os.homedir(), '.aionui/database.db');
  const db = await sqlite.open({ filename: dbPath, driver: sqlite3.Database });
  
  // 读取消息列表
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
      attachments
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `, sessionId);
  
  // 转换为标准 trace 格式
  return {
    sessionId,
    agentId: 'aionui',
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.created_at,
      tokens: {
        input: m.tokens_input || 0,
        output: m.tokens_output || 0
      },
      model: m.model_used,
      toolCalls: JSON.parse(m.tool_calls || '[]'),
      attachments: JSON.parse(m.attachments || '[]')
    })),
    stats: buildTraceStats(messages)
  };
}

// 修改主聚合函数
export async function listAllSessions(options = {}) {
  const [claudeSessions, codexSessions, cursorSessions, aionuiSessions] = 
    await Promise.all([
      listClaudeSessions(options),
      listCodexSessions(options),
      listCursorSessions(options),
      listAionUiSessions(options),  // 新增
    ]);
  
  return [...claudeSessions, ...codexSessions, ...cursorSessions, ...aionuiSessions];
}
```

#### 文件：`client/electron/local-gateway.js`
```javascript
// User-Agent 识别优化
function detectAppFromRequest(req) {
  const ua = req.headers['user-agent'] || '';
  
  // 现有检测逻辑
  if (ua.includes('claude-code')) return 'claude-code';
  if (ua.includes('codex')) return 'codex';
  if (ua.includes('cursor')) return 'cursor';
  
  // 新增 AionUi 检测
  if (ua.includes('aionui') || ua.includes('electron-aionui')) {
    return 'aionui-desktop';
  }
  
  // 通过 API Key 识别
  const apiKey = extractApiKey(req);
  if (apiKey && apiKey.startsWith('tb-aionui-')) {
    return 'aionui-desktop';
  }
  
  return 'unknown';
}

// 统计增强：区分助手类型
async function recordUsage(req, resp, routeResult) {
  const appId = detectAppFromRequest(req);
  
  // 如果是 AionUi，尝试提取助手类型
  let assistantType = null;
  if (appId === 'aionui-desktop') {
    assistantType = extractAssistantType(req);  // 从消息或上下文提取
  }
  
  await db.run(`
    INSERT INTO local_stats (
      request_id, app_id, model, tokens_input, tokens_output,
      cost_usd, billing_type, assistant_type, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    req.id,
    appId,
    routeResult.model,
    resp.usage.prompt_tokens,
    resp.usage.completion_tokens,
    calculateCost(resp.usage, routeResult.model),
    routeResult.billingType,
    assistantType,  // 新增字段
    Date.now()
  ]);
}
```

### 5.2 前端界面修改

#### 文件：`client/src/pages/Gateway.vue`
```vue
<template>
  <div class="gateway-page">
    <!-- 现有内容 -->
    
    <!-- 新增 AionUi 应用卡片 -->
    <div v-if="aionuiDetected" class="app-card aionui">
      <div class="app-header">
        <img src="@/assets/icons/aionui.svg" class="app-icon" />
        <div class="app-info">
          <h3>AionUi Desktop</h3>
          <p class="version">v{{ aionuiVersion }}</p>
        </div>
        <div class="status-badge" :class="aionuiStatus">
          {{ aionuiStatusText }}
        </div>
      </div>
      
      <div class="app-stats" v-if="aionuiStatus === 'tracked'">
        <div class="stat-item">
          <span class="label">今日调用</span>
          <span class="value">{{ aionuiStats.calls }}</span>
        </div>
        <div class="stat-item">
          <span class="label">Token 用量</span>
          <span class="value">{{ formatTokens(aionuiStats.tokens) }}</span>
        </div>
        <div class="stat-item">
          <span class="label">预估成本</span>
          <span class="value">${{ aionuiStats.cost.toFixed(3) }}</span>
        </div>
      </div>
      
      <div class="app-actions">
        <button 
          v-if="aionuiStatus === 'detected'"
          @click="onboardAionUi"
          class="btn-primary"
        >
          一键纳管
        </button>
        
        <template v-else-if="aionuiStatus === 'tracked'">
          <select v-model="aionuiRouteId" class="route-select">
            <option value="">直连官方</option>
            <option v-for="r in routes" :key="r.id" :value="r.id">
              {{ r.name }}
            </option>
          </select>
          <button @click="revertAionUi" class="btn-secondary">
            还原
          </button>
        </template>
      </div>
      
      <!-- 助手类型统计 -->
      <div v-if="aionuiStats.byAssistant" class="assistant-breakdown">
        <h4>按助手类型统计</h4>
        <div class="assistant-list">
          <div 
            v-for="(stat, type) in aionuiStats.byAssistant" 
            :key="type"
            class="assistant-item"
          >
            <span class="assistant-name">{{ type }}</span>
            <span class="assistant-calls">{{ stat.calls }} 次</span>
            <span class="assistant-tokens">{{ formatTokens(stat.tokens) }}</span>
            <span class="assistant-cost">${{ stat.cost.toFixed(3) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { detectAionUi, onboardAionUi as onboard, revertAionUi as revert } from '@/api/agents';

const aionuiDetected = ref(false);
const aionuiVersion = ref('');
const aionuiStatus = ref('detected');
const aionuiRouteId = ref('');
const aionuiStats = ref({
  calls: 0,
  tokens: 0,
  cost: 0,
  byAssistant: {}
});

onMounted(async () => {
  const detection = await detectAionUi();
  if (detection) {
    aionuiDetected.value = true;
    aionuiVersion.value = detection.version;
    aionuiStatus.value = detection.status;
    await loadStats();
  }
});

async function onboardAionUi() {
  const result = await onboard({ routeId: aionuiRouteId.value });
  if (result.success) {
    aionuiStatus.value = 'tracked';
    await loadStats();
  }
}

async function revertAionUi() {
  const result = await revert();
  if (result.success) {
    aionuiStatus.value = 'detected';
  }
}

async function loadStats() {
  const stats = await fetch('/api/stats/app/aionui-desktop').then(r => r.json());
  aionuiStats.value = stats;
}
</script>
```

#### 文件：`client/src/pages/Dashboard.vue`
```vue
<!-- 新增助手类型统计模块 -->
<div class="stats-section assistant-stats">
  <h3>热门助手（AionUi）</h3>
  <div class="assistant-chart">
    <div 
      v-for="a in topAssistants" 
      :key="a.type"
      class="assistant-bar"
    >
      <div class="bar-label">
        <span class="assistant-icon">{{ getAssistantIcon(a.type) }}</span>
        <span class="assistant-name">{{ a.name }}</span>
      </div>
      <div class="bar-container">
        <div 
          class="bar-fill"
          :style="{ width: (a.calls / maxCalls * 100) + '%' }"
        ></div>
        <span class="bar-value">{{ a.calls }} 次</span>
      </div>
      <div class="bar-cost">${{ a.cost.toFixed(2) }}</div>
    </div>
  </div>
</div>

<script setup>
function getAssistantIcon(type) {
  const icons = {
    'Cowork': '🤝',
    'PPT Creator': '📊',
    'Word Creator': '📝',
    'Excel Creator': '📗',
    'Academic Paper Writer': '🎓',
    'Planning with Files': '📋'
  };
  return icons[type] || '🤖';
}
</script>
```

### 5.3 数据库 Schema 扩展

```sql
-- 扩展 local_stats 表，添加助手类型字段
ALTER TABLE local_stats ADD COLUMN assistant_type TEXT;

-- 创建 AionUi 会话元数据表
CREATE TABLE IF NOT EXISTS aionui_sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT,
  assistant_type TEXT,
  workspace_path TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  total_messages INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_aionui_sessions_assistant 
  ON aionui_sessions(assistant_type);
CREATE INDEX IF NOT EXISTS idx_aionui_sessions_updated 
  ON aionui_sessions(updated_at DESC);
```

### 5.4 文档和示例

#### 文件：`docs/integration/aionui.md`
```markdown
# AionUi 集成指南

## 概述

Token Bank 支持与 AionUi 无缝集成，为 AionUi 的所有功能（Office 文档生成、定时任务、团队协作等）提供智能路由和成本控制能力。

## 快速开始

### 前置条件

1. 已安装 Token Bank（桌面版或 CLI）
2. 已安装 [AionUi](https://github.com/iOfficeAI/AionUi)
3. Token Bank 网关正常运行（`localhost:11430`）

### 一键集成

1. 打开 Token Bank → **网关** 页面
2. 找到 AionUi Desktop 卡片
3. 点击 **一键纳管** 按钮
4. 重启 AionUi（配置自动生效）

就这么简单！现在 AionUi 的所有 LLM 请求都会经过 Token Bank 网关。

## 功能特性

### 1. 成本追踪

所有 AionUi 的 LLM 调用都会被 Token Bank 记录：
- Token 用量（输入/输出）
- 模型使用情况
- 预估成本（支持 30+ 模型）
- 按助手类型细分统计

### 2. 智能路由

Token Bank 自动为 AionUi 选择最优供给源：
```
Office 文档生成（需要高质量）
  → 付费 API（Claude Sonnet / GPT-4o）

日常对话
  → 免费 API（Groq / GitHub Models）

代码补全
  → 本地 Ollama（零成本，低延迟）
```

### 3. 供给链优化

配置降级策略，在付费 API 不可用时自动切换：
- Groq 免费额度优先
- GitHub Models 备用
- 本地 Ollama 兜底

## 手动配置（可选）

如果需要手动配置 AionUi：

### 步骤 1：在 Token Bank 生成 API Key

```bash
# 使用 CLI
node cli/admin-api.js create-key aionui "AionUi Integration"

# 或在 Gateway 页面 UI 中创建
```

### 步骤 2：配置 AionUi

编辑 `~/.aionui/config.json`：

```json
{
  "llmPlatforms": [
    {
      "type": "custom",
      "name": "Token Bank Gateway",
      "baseUrl": "http://localhost:11430/v1",
      "apiKey": "tb-your-generated-key",
      "models": [
        "gpt-4o",
        "gpt-4o-mini",
        "claude-sonnet-4-6",
        "claude-sonnet-4-0",
        "gemini-2.0-flash-exp"
      ],
      "enabled": true
    }
  ]
}
```

### 步骤 3：重启 AionUi

配置立即生效，无需额外操作。

## 查看统计

### Dashboard 页面

- **应用占比**：查看 AionUi 在所有应用中的使用占比
- **模型排行**：了解哪些模型最常用
- **成本趋势**：按天/周/月查看成本变化

### Gateway 页面

- **实时用量**：今日调用次数、Token 用量、预估成本
- **助手类型统计**：按 PPT/Word/Excel/Cowork 分类
- **调用日志**：每次请求的详细信息（模型、Token、延迟、路由结果）

## 高级用法

### 按助手类型设置不同路由

为不同的 AionUi 助手配置专属路由：

1. 在 Token Bank **Gateway** → **场景路由** 创建：
   - `aionui-office`：Office 文档生成专用（高质量模型）
   - `aionui-chat`：日常对话（免费/廉价模型）
   - `aionui-code`：代码任务（本地 Ollama）

2. 在 AionUi 中为每个助手配置对应的 Token Bank Key

### Session 导出与 Handoff

Token Bank 支持读取 AionUi 会话：

```bash
# 列出所有 AionUi 会话
node cli/session-manager.js list --agent aionui

# 导出会话
node cli/session-manager.js export <session-id> --format json

# 跨 Agent 续聊
node cli/session-manager.js handoff <session-id> --to codex
```

## 故障排除

### AionUi 未检测到

检查 AionUi 是否已安装：
```bash
ls ~/.aionui
ls ~/Library/Application\ Support/aionui  # macOS
```

### 网关连接失败

1. 确认 Token Bank 网关正在运行：
   ```bash
   curl http://localhost:11430/health
   ```

2. 检查 AionUi 配置中的 baseUrl：
   ```bash
   cat ~/.aionui/config.json | grep baseUrl
   ```

3. 查看 Token Bank 日志：
   - 桌面版：帮助 → 查看日志
   - CLI：`tail -f ~/.tokenbank/gateway.log`

### 统计数据不准确

强制重新扫描 AionUi 会话：
```bash
node cli/session-import.js scan --agent aionui --force
```

## 最佳实践

1. **定期查看 Dashboard**：了解成本趋势，及时调整路由策略
2. **配置降级链**：避免单点故障，确保服务可用性
3. **使用场景路由**：不同任务类型用不同供给源，平衡成本与质量
4. **监控免费额度**：Groq / GitHub Models 配额用满后自动切换
5. **导出重要会话**：使用 Session Manager 备份关键对话

## 常见问题

**Q: 集成后 AionUi 是否还能单独使用？**  
A: 可以。点击 **还原** 按钮即可恢复 AionUi 原始配置。

**Q: 集成后会影响 AionUi 的性能吗？**  
A: 几乎无影响。Token Bank 网关的延迟通常 < 10ms，且支持流式响应。

**Q: 如何确认流量经过了 Token Bank？**  
A: 在 Gateway 页面查看实时日志，或检查 Dashboard 的今日用量。

**Q: 支持 AionUi 的所有功能吗？**  
A: 是的，包括 Office 文档生成、定时任务、团队协作、远程访问等。

## 更多资源

- [Token Bank 完整文档](../README.md)
- [AionUi 官方文档](https://github.com/iOfficeAI/AionUi)
- [路由策略配置指南](./routing.md)
- [成本优化技巧](./cost-optimization.md)
```

---

## 六、预期效果与指标

### 6.1 用户价值

**对于 Token Bank 用户**：
- ✅ 获得丰富的上层应用场景（Office 文档、定时任务、远程访问）
- ✅ 保持原有的成本控制和路由优化能力
- ✅ 一键纳管，配置简单

**对于 AionUi 用户**：
- ✅ 获得智能路由和供给链优化
- ✅ 精确的成本追踪和统计分析
- ✅ 自动降级到免费/廉价模型，节省开支

### 6.2 成功指标

**用户指标**：
- 集成后 7 天留存率 > 80%
- 平均 LLM 成本下降 30-50%（通过智能路由）
- 用户反馈满意度 > 4.5/5

**技术指标**：
- AionUi 流量检测准确率 > 95%
- 一键纳管成功率 > 90%
- Session 导入完整性 > 98%
- 网关延迟增加 < 10ms

### 6.3 风险与应对

**风险 1：AionUi 配置格式变更**
- 应对：维护配置版本兼容层，监控上游更新

**风险 2：用户配置冲突**
- 应对：备份原始配置，提供一键还原

**风险 3：性能影响**
- 应对：网关优化，异步日志记录，压力测试

---

## 七、总结与展望

### 7.1 核心价值

AionUi 与 Token Bank 的集成是**功能互补的完美结合**：
- Token Bank 提供**底层能力**：成本控制、智能路由、供给链优化
- AionUi 提供**上层场景**：Office 助手、定时任务、团队协作、远程访问

两者结合形成**全栈 AI 工作流平台**，覆盖从成本管理到任务执行的完整链路。

### 7.2 竞争优势

集成后的产品组合具有独特优势：

| 对比维度 | Claude Code | Cursor | **Token Bank + AionUi** |
|---------|-------------|--------|-------------------------|
| Agent 引擎 | ✅ 内置 | ✅ 内置 | ✅ 内置（AionUi） |
| 成本可见 | ❌ 无 | ⚠️ 简单 | ✅ 精确到每次调用 |
| 智能路由 | ❌ 无 | ❌ 无 | ✅ 多层降级链 |
| 多 Agent | ❌ 单一 | ❌ 单一 | ✅ 20+ Agent |
| Office 助手 | ❌ 无 | ❌ 无 | ✅ PPT/Word/Excel |
| 定时任务 | ❌ 无 | ❌ 无 | ✅ Cron 调度 |
| 远程访问 | ⚠️ 有限 | ❌ 无 | ✅ WebUI + Bot |
| 成本 | $100/月 | $20-40/月 | **免费开源** |

### 7.3 未来方向

**短期（1-3 个月）**：
- 完成基础集成，发布详细文档
- 收集用户反馈，优化体验
- 推出集成版本的联合推广

**中期（3-6 个月）**：
- Session 深度整合（跨 Agent handoff）
- 知识提炼包含 AionUi 会话内容
- 统计面板增强（助手类型、文档类型细分）

**长期（6-12 个月）**：
- 考虑更深度的产品整合（方案二）
- 探索商业化路径（Pro 版本、企业版）
- 建设生态系统（插件市场、助手商店）

---

## 八、行动计划

### 下一步行动

1. **决策确认**（1 天）
   - [ ] 确认采用方案一
   - [ ] 组建集成小组

2. **技术准备**（3 天）
   - [ ] 搭建 AionUi 测试环境
   - [ ] 分析 AionUi 配置文件格式
   - [ ] 设计数据库 schema 扩展

3. **开发实施**（2-3 周）
   - [ ] 阶段一：基础集成（检测、纳管、统计）
   - [ ] 阶段二：深度整合（Session、Handoff）
   - [ ] 阶段三：体验优化（文档、示例）

4. **测试验证**（1 周）
   - [ ] 功能测试
   - [ ] 性能测试
   - [ ] 用户体验测试

5. **发布推广**（持续）
   - [ ] 编写集成文档
   - [ ] 录制视频教程
   - [ ] 社区推广和案例展示

---

**附录**：
- [AionUi GitHub 仓库](https://github.com/iOfficeAI/AionUi)
- [Token Bank 设计文档](../DESIGN.md)
- [Token Bank 代码逻辑总览](../CODEBASE-LOGIC.md)

---

_文档版本：v1.0_  
_最后更新：2026-07-05_
