# Agent 聚合系统测试指南

## 启动应用

应用已在后台 tmux 会话中运行：

```bash
# 查看开发服务器日志
tmux -f /exec-daemon/tmux.portal.conf attach-session -t tokenbank-dev

# 退出 tmux（不关闭会话）
按 Ctrl+B，然后按 D
```

如果需要重启：
```bash
cd /workspace/client
npm run dev
```

## 测试步骤

### 1. 验证 UI 切换

1. 打开 Token Bank 应用
2. 导航到 **Debug** 页面（左侧菜单）
3. 查看顶部是否显示模式切换器：
   - 💬 LLM 模式
   - 🤖 Agent 模式

### 2. 测试 LLM 模式（确保原功能正常）

1. 确保在 **LLM 模式**
2. 选择一个 Provider（如本地网关）
3. 选择一个模型
4. 发送测试消息
5. 验证对话功能正常

### 3. 测试 Agent 模式

#### 3.1 切换到 Agent 模式
1. 点击 **🤖 Agent 模式** 按钮
2. 界面应该显示：
   - 左侧：Agent 选择器（3列宽）
   - 右侧：执行区域（9列宽）
   - 底部：任务输入框

#### 3.2 查看可用 Agent
左侧应显示：
- Claude Code Agent
- Codex Agent

每个 Agent 卡片显示：
- 名称
- 状态标识（"已纳管"）
- 能力标签（code, chat, edit）
- 版本号（如果有）

#### 3.3 选择 Agent
1. 点击任意 Agent 卡片
2. 卡片应高亮显示（蓝色边框）
3. 右侧区域应显示提示信息

#### 3.4 配置工作目录（可选）
1. 在顶部 "工作目录" 输入框输入路径
2. 或留空使用默认工作目录

#### 3.5 执行任务

**简单测试任务：**
```
创建一个 hello.txt 文件，内容是 "Hello from Agent!"
```

**代码任务：**
```
在 /workspace/test-output 目录创建一个简单的 Python 脚本，
打印当前时间和系统信息
```

操作：
1. 在底部输入框输入任务描述
2. 点击 **▶ 执行** 按钮（或按 Cmd/Ctrl+Enter）
3. 观察实时日志更新

#### 3.6 查看执行日志

执行过程中，右侧应实时显示：
- 🤔 **thinking**: Agent 的思考过程
- 🔧 **tool_call**: 调用的工具
- ✏️ **code_edit**: 代码编辑操作
- 🏃 **terminal**: 终端命令
- 📄 **output**: 输出信息

每个步骤显示：
- 时间戳
- 步骤类型
- 详细内容

#### 3.7 查看执行结果

任务完成后，应显示：
- ✅ **任务完成** 或 ❌ **任务失败**
- **修改的文件列表**：
  - 文件路径
  - 操作类型（新建/修改）
- **执行统计**：
  - ⏱️ 耗时
  - 🔤 Token 使用量（input + output）
  - 💰 成本
  - 📊 步骤数

#### 3.8 取消任务
1. 在任务执行过程中
2. 点击 **⏹ 停止** 按钮
3. 任务应停止执行

### 4. 验证数据库记录

检查任务是否正确记录到数据库：

```bash
# 查看 SQLite 数据库位置
ls -la ~/Library/Application\ Support/Token\ Bank/  # macOS
ls -la ~/.config/Token\ Bank/                        # Linux
ls -la %APPDATA%\Token Bank\                         # Windows

# 使用 sqlite3 查询
sqlite3 "~/Library/Application Support/Token Bank/local-stats.db"

-- 查看任务记录
SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT 5;

-- 查看步骤记录
SELECT task_id, step_number, step_type, content 
FROM agent_task_steps 
WHERE task_id = 'YOUR_TASK_ID';

-- 查看修改的文件
SELECT * FROM agent_modified_files 
WHERE task_id = 'YOUR_TASK_ID';
```

## 常见问题

### Agent 列表为空
- 确保在 **Gateway** 页面纳管了 Agent
- 检查 Agent 配置是否正确
- 重启应用

### 执行失败
- 检查工作目录权限
- 查看控制台错误日志
- 确保 Agent 可执行文件存在

### 日志不更新
- 检查浏览器控制台是否有错误
- 查看 Electron 主进程日志
- 检查 IPC 通信是否正常

### 无法取消任务
- 某些 Agent 可能不支持强制终止
- 等待当前步骤完成
- 重启应用

## 调试信息

### 查看主进程日志
```bash
# 在 tmux 会话中查看
tmux -f /exec-daemon/tmux.portal.conf attach-session -t tokenbank-dev
```

### 查看渲染进程日志
1. 在应用中按 `Cmd+Option+I` (macOS) 或 `Ctrl+Shift+I` (Windows/Linux)
2. 打开 DevTools
3. 切换到 Console 标签

### 检查 IPC 通信
在 DevTools Console 中：
```javascript
// 列出可用 Agent
await window.electronAPI.agent.list()

// 执行测试任务
await window.electronAPI.agent.execute({
  agentId: 'claude-code',
  prompt: '创建一个测试文件',
  options: {}
})
```

## 性能检查

### 监控内存使用
```bash
# 查看 Electron 进程
ps aux | grep electron
```

### 检查数据库大小
```bash
du -h ~/Library/Application\ Support/Token\ Bank/local-stats.db
```

## 下一步

测试通过后，可以：
1. 继续实施 **Phase 2: MCP 供给源管理**
2. 优化 Agent 检测逻辑
3. 添加更多 Agent 类型支持
4. 实现资源注入功能

## 反馈问题

如遇到问题，请记录：
1. 操作步骤
2. 错误信息
3. 控制台日志
4. 数据库状态
