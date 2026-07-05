# AionUi 集成方案 - 快速指南

> 📌 完整文档：[aionui-integration-analysis.md](./aionui-integration-analysis.md)

---

## 🎯 核心结论

**推荐方案**：AionUi 作为 Token Bank 的前置 Agent（最小侵入性集成）

**价值主张**：
- Token Bank 获得 → 丰富的应用场景（Office 助手、定时任务、远程访问）
- AionUi 获得 → 智能路由和成本控制能力
- 形成 → **全栈 AI 工作流平台**

---

## 📊 两个项目对比

### Token Bank（当前项目）
- 🎯 **定位**：本地 LLM 网关 + Token 管理器
- ⚡ **核心**：成本追踪、智能路由、供给链优化、P2P 网络
- 💻 **技术**：Electron + Node.js + Python FastAPI + SQLite

### AionUi
- 🎯 **定位**：免费开源的 AI Agent Cowork 平台
- ⚡ **核心**：内置 Agent 引擎、30+ LLM 平台、Office 助手、定时任务、团队协作
- 💻 **技术**：Electron + Bun + TypeScript + Rust (aionrs)

---

## 🏗️ 集成架构

```
┌─────────────────────────────────────┐
│  AionUi Desktop / WebUI             │  ← 用户交互层
│  (Agent 引擎 + Office 助手 + 任务)   │
└────────────┬────────────────────────┘
             │ http://localhost:11430/v1
             ▼
┌─────────────────────────────────────┐
│  Token Bank Gateway                 │  ← 智能路由层
│  • 成本追踪                          │
│  • 供给源选择                        │
│  • 协议转换                          │
└────────────┬────────────────────────┘
             │
    ┌────────┴────────┬──────────┬──────────┐
    ▼                 ▼          ▼          ▼
┌────────┐  ┌──────────────┐  ┌─────┐  ┌──────────┐
│ Ollama │  │ Groq / GitHub│  │ P2P │  │ OpenAI / │
│  本地  │  │   免费 API   │  │网络 │  │ Claude   │
└────────┘  └──────────────┘  └─────┘  └──────────┘
```

---

## 🚀 实施步骤

### 阶段一：基础集成（1-2 周）
1. ✅ Token Bank 添加 AionUi 检测逻辑
2. ✅ 实现一键纳管（自动配置 AionUi → Token Bank）
3. ✅ Gateway 页面显示 AionUi 用量统计
4. ✅ 测试：Office 文档生成、定时任务的成本追踪

### 阶段二：深度整合（2-3 周）
1. ✅ Session Manager 读取 AionUi 会话数据
2. ✅ Handoff 支持 AionUi 作为目标 Agent
3. ✅ 知识提炼包含 AionUi 会话
4. ✅ Dashboard 按助手类型细分统计

### 阶段三：体验优化（1-2 周）
1. ✅ 编写详细文档和视频教程
2. ✅ 提供配置模板和最佳实践
3. ✅ 社区推广和案例展示

**总计：4-7 周完成完整集成**

---

## 🔧 核心修改点

### 1. 检测 AionUi
**文件**：`client/electron/detect-tools.js`
```javascript
export async function detectAionUi() {
  const paths = [
    '~/.aionui',
    '~/Library/Application Support/aionui',  // macOS
    '~/AppData/Roaming/aionui'               // Windows
  ];
  // 检测安装、读取版本、返回配置路径
}
```

### 2. 一键纳管
**文件**：`client/electron/agent-linker.js`
```javascript
export async function onboardAionUi(routeId) {
  // 1. 生成本地 API Key
  // 2. 修改 ~/.aionui/config.json
  // 3. 添加 Token Bank Gateway 作为 LLM 平台
  // 4. 记录纳管状态
}
```

### 3. Session 读取
**文件**：`client/electron/session-browser.js`
```javascript
export async function listAionUiSessions() {
  // 读取 ~/.aionui/database.db
  // 解析 conversations 和 messages 表
  // 返回标准化的 session 列表
}
```

### 4. 流量识别
**文件**：`client/electron/local-gateway.js`
```javascript
function detectAppFromRequest(req) {
  const ua = req.headers['user-agent'];
  if (ua.includes('aionui') || ua.includes('electron-aionui')) {
    return 'aionui-desktop';
  }
  // 或通过 API Key 前缀识别：tb-aionui-*
}
```

### 5. 统计增强
```sql
-- 扩展 local_stats 表
ALTER TABLE local_stats ADD COLUMN assistant_type TEXT;

-- 新建 AionUi 会话表
CREATE TABLE aionui_sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT,
  assistant_type TEXT,  -- Cowork/PPT/Word/Excel 等
  workspace_path TEXT,
  total_tokens INTEGER,
  total_cost_usd REAL
);
```

---

## 📈 预期效果

### 用户价值
- ✅ Token Bank 用户获得丰富应用场景
- ✅ AionUi 用户获得智能路由和成本控制
- ✅ 平均 LLM 成本下降 30-50%

### 成功指标
- 🎯 集成后 7 天留存率 > 80%
- 🎯 一键纳管成功率 > 90%
- 🎯 网关延迟增加 < 10ms
- 🎯 用户满意度 > 4.5/5

---

## 💡 核心技术点

### AionUi 配置修改
编辑 `~/.aionui/config.json`：
```json
{
  "llmPlatforms": [
    {
      "type": "custom",
      "name": "Token Bank Gateway",
      "baseUrl": "http://localhost:11430/v1",
      "apiKey": "tb-aionui-xxxxx",
      "models": ["gpt-4o", "claude-sonnet-4-6", "gemini-2.0-flash-exp"],
      "enabled": true
    }
  ]
}
```

### Gateway 页面新增
```vue
<div class="app-card aionui">
  <div class="app-header">
    <img src="aionui-icon.svg" />
    <h3>AionUi Desktop</h3>
    <span class="status-badge">已纳管</span>
  </div>
  
  <div class="app-stats">
    <div>今日调用: 156</div>
    <div>Token 用量: 45.2K</div>
    <div>预估成本: $0.023</div>
  </div>
  
  <div class="assistant-breakdown">
    <div>PPT Creator: 45 次 ($0.012)</div>
    <div>Cowork: 89 次 ($0.008)</div>
    <div>Excel Creator: 22 次 ($0.003)</div>
  </div>
  
  <button @click="onboard">一键纳管</button>
  <button @click="revert">还原</button>
</div>
```

---

## ⚠️ 风险与应对

| 风险 | 影响 | 应对措施 |
|-----|------|---------|
| AionUi 配置格式变更 | 中 | 维护版本兼容层，监控上游更新 |
| 用户配置冲突 | 低 | 备份原始配置，提供一键还原 |
| 性能影响 | 低 | 异步日志，压力测试，< 10ms 延迟 |
| 检测失败 | 中 | 提供手动配置选项 |

---

## 🎁 附加价值

### 对 Token Bank
- ✅ 用户场景扩展（Office/定时任务/远程访问）
- ✅ 用户留存提升
- ✅ 生态系统完善

### 对 AionUi
- ✅ 成本优化能力（智能路由）
- ✅ 数据洞察（精确统计）
- ✅ 供给源扩展（P2P 网络）

### 联合竞争力
| 维度 | Claude Code | Cursor | Token Bank + AionUi |
|-----|------------|--------|---------------------|
| 成本可见 | ❌ | ⚠️ | ✅ 精确 |
| 智能路由 | ❌ | ❌ | ✅ 多层降级 |
| Office 助手 | ❌ | ❌ | ✅ |
| 定时任务 | ❌ | ❌ | ✅ |
| 远程访问 | ⚠️ | ❌ | ✅ |
| 价格 | $100/月 | $20-40/月 | **免费** |

---

## 📚 相关文档

- 📖 [完整集成分析](./aionui-integration-analysis.md)
- 🏗️ [Token Bank 设计文档](../DESIGN.md)
- 💻 [代码逻辑总览](../CODEBASE-LOGIC.md)
- 🔗 [AionUi GitHub](https://github.com/iOfficeAI/AionUi)

---

## 🎯 下一步

1. **决策**：确认采用方案一
2. **准备**：搭建 AionUi 测试环境（3 天）
3. **开发**：按三个阶段实施（4-7 周）
4. **测试**：功能 + 性能 + 体验（1 周）
5. **发布**：文档 + 教程 + 推广（持续）

---

_快速指南版本：v1.0 | 2026-07-05_
