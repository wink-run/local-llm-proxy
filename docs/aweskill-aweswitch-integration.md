# aweskill & aweswitch 集成方案

> 技能管理 + 配置切换，打造完整的 Agent 生态系统

---

## 📋 项目概览

### aweskill - AI Agent 技能包管理器

**定位**：类似 npm，但用于管理 AI Agent 的技能

**核心功能**：
- 🗂️ **中心化存储**：统一管理技能在 `~/.aweskill/skills/`
- 🔍 **技能发现**：搜索 skills.sh、sciskillhub.org、本地存储
- 📦 **安装更新**：从 GitHub、本地路径、sciskill ID 安装
- 🔗 **多 Agent 投射**：通过 symlink/junction 投射到 47+ Agent
- 🎁 **Bundle 管理**：按项目/团队/工作流打包技能
- 🔧 **Doctor 工具**：修复损坏、重复、可疑的技能
- 🤖 **Agent 可调用**：AI Agent 可通过自然语言管理技能

**支持的 Agent**（47 个）：
Claude Code、Codex、Cursor、Gemini CLI、Qwen Code、Windsurf、OpenCode、Goose、AionUi（可扩展）...

---

### aweswitch - Agent 配置切换工具

**定位**：快速切换 AI Agent 的 API 端点、模型、Token

**核心功能**：
- 🔀 **配置切换**：在多个 API 端点之间快速切换
- 🚀 **Launch 模式**：启动新会话，不影响现有会话
- ✍️ **Write 模式**：修改全局配置（仅 Claude Code）
- 🔐 **安全管理**：环境变量引用，不在配置文件存储敏感信息
- 📋 **Profile 管理**：支持 Claude、Codex、OpenCode
- 🔄 **自动更新**：后台检查新版本

**配置示例**：
```json
{
  "profiles": {
    "claude": {
      "cc-glm": {
        "env": {
          "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
          "ANTHROPIC_AUTH_TOKEN": "${GLM_ANTHROPIC_AUTH_TOKEN}",
          "ANTHROPIC_MODEL": "glm-5.1"
        }
      }
    },
    "codex": {
      "cx-openai": {
        "env": {
          "OPENAI_BASE_URL": "https://api.openai.com",
          "OPENAI_API_KEY": "${OPENAI_API_KEY}"
        }
      }
    }
  }
}
```

---

## 🎯 与 Token Bank 的集成价值

### 核心互补性

```
┌─────────────────────────────────────────────────────┐
│  Token Bank（成本管理 + 智能路由）                    │
│  ├─ 用量追踪                                        │
│  ├─ 智能路由（本地/免费/P2P/付费）                   │
│  ├─ 成本分析                                        │
│  └─ Agent 纳管                                      │
└───────────┬─────────────────────────────────────────┘
            │
    ┌───────┴────────┬───────────────────┐
    │                │                   │
    ▼                ▼                   ▼
┌────────────┐  ┌──────────┐  ┌──────────────────┐
│  aweskill  │  │aweswitch │  │   AionUi         │
│  技能管理  │  │配置切换  │  │   Agent 平台     │
└────────────┘  └──────────┘  └──────────────────┘
```

### 三层价值叠加

| 层次 | Token Bank | aweskill | aweswitch |
|-----|-----------|----------|-----------|
| **成本层** | ✅ 追踪/优化/路由 | ⚪ | ⚪ |
| **能力层** | ✅ Agent 纳管 | ✅ 技能增强 | ⚪ |
| **配置层** | ⚪ | ⚪ | ✅ 快速切换 |

---

## 🏗️ 集成方案

### 方案一：Token Bank 集成 aweskill（推荐 ⭐）

**目标**：让 Token Bank 管理和展示 Agent 技能

#### 1.1 技能同步模块

**文件**：`client/electron/aweskill-bridge.js`（新建）

```javascript
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

export class AweskillBridge {
  /**
   * 检查 aweskill 是否安装
   */
  static async isInstalled() {
    try {
      const result = await this.exec('aweskill --version');
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * 获取已安装的技能列表
   */
  static async listSkills() {
    const result = await this.exec('aweskill store list --verbose');
    if (!result.success) return [];
    
    // 解析输出
    return this.parseSkillList(result.output);
  }

  /**
   * 获取 Agent 投射状态
   */
  static async getAgentProjections(agentId) {
    // aweskill agent list --global --agent <agent>
    const result = await this.exec(`aweskill agent list --global --agent ${agentId}`);
    if (!result.success) return [];
    
    return this.parseProjections(result.output);
  }

  /**
   * 为 Agent 投射技能
   */
  static async projectSkills(agentId, skills) {
    const skillList = skills.join(',');
    const result = await this.exec(
      `aweskill agent add skill ${skillList} --global --agent ${agentId}`
    );
    return result;
  }

  /**
   * 搜索技能
   */
  static async findSkills(query, options = {}) {
    let cmd = `aweskill find "${query}"`;
    if (options.local) cmd += ' --local';
    if (options.provider) cmd += ` --provider ${options.provider}`;
    
    const result = await this.exec(cmd);
    if (!result.success) return [];
    
    return this.parseSearchResults(result.output);
  }

  /**
   * 安装技能
   */
  static async installSkill(source) {
    const result = await this.exec(`aweskill store install ${source}`);
    return result;
  }

  /**
   * 执行 aweskill 命令
   */
  static async exec(command) {
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', command]);
      let output = '';
      let error = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        error += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          output,
          error,
          exitCode: code
        });
      });
    });
  }

  /**
   * 解析技能列表
   */
  static parseSkillList(output) {
    // TODO: 解析 aweskill 输出格式
    // 返回 { name, path, source, description }[]
    const skills = [];
    
    const lines = output.split('\n');
    for (const line of lines) {
      // 解析每行技能信息
      const match = line.match(/^\s*-\s+([^\s]+)\s+(.+)$/);
      if (match) {
        skills.push({
          name: match[1],
          description: match[2],
          path: path.join(os.homedir(), '.aweskill/skills', match[1])
        });
      }
    }
    
    return skills;
  }

  /**
   * 解析投射状态
   */
  static parseProjections(output) {
    // TODO: 解析 aweskill agent list 输出
    // 返回 { linked, broken, duplicate, matched, new, suspicious }
    return {
      linked: [],
      broken: [],
      duplicate: [],
      matched: [],
      new: [],
      suspicious: []
    };
  }

  /**
   * 解析搜索结果
   */
  static parseSearchResults(output) {
    // TODO: 解析 aweskill find 输出
    // 返回 { name, source, description, provider }[]
    const results = [];
    
    const lines = output.split('\n');
    for (const line of lines) {
      // 解析搜索结果
      if (line.includes('source:')) {
        const nameMatch = line.match(/(\S+)\s+source:/);
        const sourceMatch = line.match(/source:\s+(\S+)/);
        
        if (nameMatch && sourceMatch) {
          results.push({
            name: nameMatch[1],
            source: sourceMatch[1],
            provider: 'skills.sh' // 或从输出推断
          });
        }
      }
    }
    
    return results;
  }
}
```

#### 1.2 IPC 接口扩展

**文件**：`client/electron/main.js`

```javascript
import { AweskillBridge } from './aweskill-bridge.js';

// 检查 aweskill 是否安装
ipcMain.handle('aweskill-check', async () => {
  return await AweskillBridge.isInstalled();
});

// 获取技能列表
ipcMain.handle('aweskill-list-skills', async () => {
  return await AweskillBridge.listSkills();
});

// 获取 Agent 投射状态
ipcMain.handle('aweskill-get-projections', async (event, agentId) => {
  return await AweskillBridge.getAgentProjections(agentId);
});

// 投射技能到 Agent
ipcMain.handle('aweskill-project-skills', async (event, { agentId, skills }) => {
  return await AweskillBridge.projectSkills(agentId, skills);
});

// 搜索技能
ipcMain.handle('aweskill-find', async (event, { query, options }) => {
  return await AweskillBridge.findSkills(query, options);
});

// 安装技能
ipcMain.handle('aweskill-install', async (event, source) => {
  return await AweskillBridge.installSkill(source);
});
```

#### 1.3 Gateway 页面扩展

**文件**：`client/src/pages/Gateway.jsx`

在 Agent 卡片中添加技能管理：

```jsx
<div className="agent-card">
  <div className="agent-header">
    <h3>{agent.name}</h3>
    <span className="status">{agent.status}</span>
  </div>
  
  {/* 新增：技能管理区域 */}
  <div className="agent-skills">
    <div className="skills-header">
      <h4>已投射技能 ({projectedSkills.length})</h4>
      <button onClick={() => openSkillManager(agent.id)}>
        管理技能
      </button>
    </div>
    
    <div className="skills-list">
      {projectedSkills.map(skill => (
        <div key={skill.name} className="skill-tag">
          <span className="skill-icon">📦</span>
          <span className="skill-name">{skill.name}</span>
          <button 
            className="skill-remove"
            onClick={() => removeSkill(agent.id, skill.name)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
    
    {/* 技能状态警告 */}
    {brokenSkills.length > 0 && (
      <div className="skill-warning">
        ⚠️ {brokenSkills.length} 个技能损坏 
        <button onClick={() => repairSkills(agent.id)}>修复</button>
      </div>
    )}
  </div>
</div>
```

#### 1.4 技能管理对话框

**文件**：`client/src/components/SkillManager.jsx`（新建）

```jsx
export default function SkillManager({ agentId, onClose }) {
  const [installedSkills, setInstalledSkills] = useState([]);
  const [projectedSkills, setProjectedSkills] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);

  // 加载数据
  useEffect(() => {
    loadInstalledSkills();
    loadProjectedSkills();
  }, [agentId]);

  async function loadInstalledSkills() {
    const skills = await window.electronAPI.aweskillListSkills();
    setInstalledSkills(skills);
  }

  async function loadProjectedSkills() {
    const projections = await window.electronAPI.aweskillGetProjections(agentId);
    setProjectedSkills(projections.linked || []);
  }

  async function handleSearch() {
    const results = await window.electronAPI.aweskillFind({
      query: searchQuery,
      options: {}
    });
    setSearchResults(results);
  }

  async function handleInstall(source) {
    const result = await window.electronAPI.aweskillInstall(source);
    if (result.success) {
      await loadInstalledSkills();
      alert('技能安装成功！');
    } else {
      alert(`安装失败：${result.error}`);
    }
  }

  async function handleProject() {
    const result = await window.electronAPI.aweskillProjectSkills({
      agentId,
      skills: selectedSkills
    });
    
    if (result.success) {
      await loadProjectedSkills();
      setSelectedSkills([]);
      alert('技能投射成功！');
    } else {
      alert(`投射失败：${result.error}`);
    }
  }

  return (
    <div className="skill-manager-modal">
      <div className="modal-header">
        <h2>技能管理 - {agentId}</h2>
        <button onClick={onClose}>×</button>
      </div>
      
      <div className="modal-body">
        {/* 搜索区域 */}
        <div className="search-section">
          <h3>🔍 搜索技能</h3>
          <div className="search-bar">
            <input 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="搜索技能..."
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
            />
            <button onClick={handleSearch}>搜索</button>
          </div>
          
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map(skill => (
                <div key={skill.name} className="search-result-item">
                  <div className="skill-info">
                    <h4>{skill.name}</h4>
                    <p>{skill.description}</p>
                    <code>{skill.source}</code>
                  </div>
                  <button onClick={() => handleInstall(skill.source)}>
                    安装
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        
        {/* 已安装技能 */}
        <div className="installed-section">
          <h3>📦 已安装技能 ({installedSkills.length})</h3>
          <div className="skill-grid">
            {installedSkills.map(skill => {
              const isProjected = projectedSkills.some(s => s.name === skill.name);
              const isSelected = selectedSkills.includes(skill.name);
              
              return (
                <div 
                  key={skill.name} 
                  className={`skill-card ${isProjected ? 'projected' : ''} ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    if (!isProjected) {
                      setSelectedSkills(prev => 
                        isSelected 
                          ? prev.filter(s => s !== skill.name)
                          : [...prev, skill.name]
                      );
                    }
                  }}
                >
                  <div className="skill-name">{skill.name}</div>
                  <div className="skill-desc">{skill.description}</div>
                  {isProjected && <span className="projected-badge">已投射</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      
      <div className="modal-footer">
        <div className="selected-count">
          已选择 {selectedSkills.length} 个技能
        </div>
        <button 
          onClick={handleProject}
          disabled={selectedSkills.length === 0}
          className="btn-primary"
        >
          投射到 {agentId}
        </button>
      </div>
    </div>
  );
}
```

---

### 方案二：Token Bank 集成 aweswitch

**目标**：在 Token Bank 中快速切换 Agent 配置

#### 2.1 配置切换桥接

**文件**：`client/electron/aweswitch-bridge.js`（新建）

```javascript
export class AweswitchBridge {
  /**
   * 检查 aweswitch 是否安装
   */
  static async isInstalled() {
    try {
      const result = await this.exec('aweswitch --version');
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * 获取所有 profiles
   */
  static async listProfiles() {
    const result = await this.exec('aweswitch list');
    if (!result.success) return [];
    
    return this.parseProfiles(result.output);
  }

  /**
   * 获取 profile 详情
   */
  static async showProfile(profileName) {
    const result = await this.exec(`aweswitch show ${profileName}`);
    if (!result.success) return null;
    
    return this.parseProfile(result.output);
  }

  /**
   * 应用 profile（Write 模式）
   */
  static async applyProfile(profileName) {
    const result = await this.exec(`aweswitch apply ${profileName}`);
    return result;
  }

  /**
   * 还原配置
   */
  static async restore() {
    const result = await this.exec('aweswitch restore');
    return result;
  }

  /**
   * 执行命令
   */
  static async exec(command) {
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', command]);
      let output = '';
      let error = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        error += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          output,
          error,
          exitCode: code
        });
      });
    });
  }

  /**
   * 解析 profiles 列表
   */
  static parseProfiles(output) {
    const profiles = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      // 解析 provider/profile 格式
      const match = line.match(/^(\w+)\/(\S+)/);
      if (match) {
        profiles.push({
          provider: match[1],
          name: match[2],
          fullName: `${match[1]}/${match[2]}`
        });
      }
    }
    
    return profiles;
  }

  /**
   * 解析 profile 详情
   */
  static parseProfile(output) {
    // TODO: 解析 profile 详情（敏感信息已脱敏）
    return {
      name: '',
      provider: '',
      env: {}
    };
  }
}
```

#### 2.2 Gateway 页面集成

在 Agent 卡片中添加配置切换：

```jsx
<div className="agent-card">
  {/* ... 现有内容 ... */}
  
  {/* 新增：配置切换 */}
  {aweswitchProfiles.length > 0 && (
    <div className="agent-profiles">
      <div className="profiles-header">
        <h4>快速切换配置</h4>
      </div>
      
      <div className="profiles-list">
        <select 
          value={currentProfile}
          onChange={e => handleProfileChange(agent.id, e.target.value)}
        >
          <option value="">官方配置</option>
          {aweswitchProfiles
            .filter(p => p.provider === agent.provider)
            .map(p => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))
          }
        </select>
        
        <button onClick={() => applyProfile(currentProfile)}>
          应用
        </button>
        
        {appliedProfile && (
          <button onClick={() => restoreProfile()}>
            还原
          </button>
        )}
      </div>
      
      {appliedProfile && (
        <div className="profile-badge">
          当前: {appliedProfile}
        </div>
      )}
    </div>
  )}
</div>
```

---

### 方案三：完整集成（Token Bank + aweskill + aweswitch + AionUi）

**终极目标**：打造完整的 Agent 生态系统管理平台

```
┌────────────────────────────────────────────────────────┐
│  Token Bank（中枢）                                     │
│  ├─ 🤖 Agent 纳管（Claude Code/Codex/AionUi/Cursor）   │
│  ├─ 💰 成本管理（追踪/分析/优化）                        │
│  ├─ 🔀 智能路由（本地/免费/P2P/付费）                    │
│  ├─ 📦 技能管理（via aweskill）                         │
│  ├─ 🔄 配置切换（via aweswitch）                        │
│  └─ 🐛 Agent 聚合入口（Debug 页面升级）                 │
└────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
    ┌─────────┐         ┌──────────┐       ┌──────────┐
    │aweskill │         │aweswitch │       │  AionUi  │
    │技能管理 │         │配置切换  │       │Agent 平台│
    └─────────┘         └──────────┘       └──────────┘
```

#### 功能矩阵

| 功能 | Token Bank | aweskill | aweswitch | AionUi |
|-----|-----------|----------|-----------|---------|
| Agent 纳管 | ✅ | ⚪ | ⚪ | ⚪ |
| 成本追踪 | ✅ | ⚪ | ⚪ | ⚪ |
| 智能路由 | ✅ | ⚪ | ⚪ | ⚪ |
| 技能管理 | 🔗 via aweskill | ✅ | ⚪ | ⚪ |
| 配置切换 | 🔗 via aweswitch | ⚪ | ✅ | ⚪ |
| Agent 执行 | 🔗 via AionUi | ⚪ | ⚪ | ✅ |
| Office 助手 | 🔗 via AionUi | ⚪ | ⚪ | ✅ |

---

## 📋 实施计划

### 阶段一：aweskill 集成（2 周）

**Week 1：桥接层**
- [ ] 创建 `AweskillBridge` 类
- [ ] 实现 IPC 接口
- [ ] 测试命令执行和解析

**Week 2：UI 集成**
- [ ] Gateway 页面添加技能展示
- [ ] 创建 `SkillManager` 组件
- [ ] 实现技能搜索/安装/投射

### 阶段二：aweswitch 集成（1 周）

- [ ] 创建 `AweswitchBridge` 类
- [ ] 实现 IPC 接口
- [ ] Gateway 页面添加配置切换
- [ ] 测试配置应用和还原

### 阶段三：深度整合（2 周）

- [ ] Agent 聚合入口支持技能调用
- [ ] 成本统计区分技能类型
- [ ] 配置切换与路由联动
- [ ] 统一的管理界面

**总计：5 周**

---

## 🎯 核心价值

### 对用户

**技能管理**：
- ✅ 一键安装和投射技能到所有 Agent
- ✅ 搜索社区技能库
- ✅ 自动修复损坏的技能
- ✅ 按项目打包技能

**配置切换**：
- ✅ 快速切换 API 端点和模型
- ✅ 多个配置并行运行
- ✅ 安全存储敏感信息
- ✅ 一键还原官方配置

**统一管理**：
- ✅ 一个界面管理所有 Agent
- ✅ 成本、技能、配置统一视图
- ✅ 智能路由自动优化成本

### 对 Token Bank

- 🔥 **生态完整性**：覆盖 Agent 全生命周期（纳管 → 技能 → 配置 → 成本）
- 🎯 **差异化**：市场上唯一的 Agent 全栈管理平台
- 📈 **用户粘性**：提供不可替代的价值
- 🌟 **社区生态**：连接 aweskill/aweswitch 社区

---

## 💡 使用场景

### 场景一：新项目启动

```bash
# 1. 通过 Token Bank 一键纳管 Claude Code
# 2. 使用 aweskill 安装项目所需技能
aweskill bundle import backend  # 安装后端技能包
aweskill agent add bundle backend --global --agent claude-code

# 3. 使用 aweswitch 切换到合适的 API 配置
aweswitch cc-glm  # 使用智谱 GLM 配置

# 4. 在 Token Bank 中查看成本和用量
```

### 场景二：多模型测试

```bash
# 在不同终端使用不同配置
Terminal 1: aweswitch cc-glm      # 使用 GLM
Terminal 2: aweswitch cc-gemini   # 使用 Gemini
Terminal 3: aweswitch cc-xiaomi   # 使用小米

# Token Bank 统一追踪所有配置的成本
```

### 场景三：团队协作

```bash
# 共享技能 bundle
aweskill bundle create team-frontend
aweskill bundle add team-frontend react,typescript,eslint

# 团队成员安装
aweskill bundle template import team-frontend
aweskill agent add bundle team-frontend --global --agent codex

# Token Bank 统计团队总体成本
```

---

## 🔗 参考资料

- [aweskill GitHub](https://github.com/mugpeng/aweskill)
- [aweswitch GitHub](https://github.com/Webioinfo01/aweswitch)
- [skills.sh - 技能社区](https://skills.sh/)
- [sciskillhub.org - 科学技能库](https://sciskillhub.org/)
- [aweshelf - 会话书签管理](https://github.com/Webioinfo01/aweshelf)

---

## 🚀 快速开始

### 前置条件

```bash
# 安装 aweskill
npm install -g aweskill
aweskill store init

# 安装 aweswitch
pip3 install aweswitch
aweswitch config init
```

### 在 Token Bank 中启用

```bash
# 开发环境
cd client
npm install
npm run dev

# Token Bank 会自动检测 aweskill 和 aweswitch
# 并在 Gateway 页面显示相关功能
```

---

_集成方案版本：v1.0 | 2026-07-05_
