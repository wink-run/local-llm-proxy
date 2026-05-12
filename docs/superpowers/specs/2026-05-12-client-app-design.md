# Client App Design — Local LLM Proxy

> 状态：已确认，待开发
> 日期：2026-05-12

---

## 1. 定位

为 Local LLM Proxy 新增桌面客户端子项目 `client/`，形态参考 Clash，支持跨平台（macOS / Windows / Linux）。面向两类用户：

- **普通用户**：只使用积分消费 API，不贡献 worker
- **贡献者**：在本机运行 agent，同时也是普通用户

---

## 2. 技术栈

| 层 | 技术 |
|----|------|
| 壳 | Electron |
| 前端 | React + Vite |
| 本地持久化 | electron-store（存 token、server_url） |
| 进程管理 | Node.js `child_process.spawn`（管理 llm-agent） |
| 样式 | Tailwind CSS |

---

## 3. 子项目结构

```
client/
├── electron/
│   ├── main.js          # 主进程：托盘、agent 子进程、IPC
│   └── preload.js       # contextBridge 暴露 ipcRenderer
├── src/
│   ├── pages/
│   │   ├── Profile.jsx      # 首页：个人信息 + 积分
│   │   ├── Agent.jsx        # Agent 管理（贡献者）
│   │   ├── Network.jsx      # 全局大屏 + 在线 worker 列表
│   │   └── Config.jsx       # 配置 + 登录管理
│   ├── components/
│   │   ├── Sidebar.jsx      # 左侧导航
│   │   └── RateChart.jsx    # 实时速率折线图
│   └── App.jsx
├── package.json
└── vite.config.js
```

---

## 4. 页面设计

### 4.1 Profile（首页）

- 用户头像、用户名
- 积分余额（大字展示）
- 统计卡片：累计贡献积分 / 累计消耗积分 / 贡献请求数 / 消耗请求数
- 积分明细列表（分页，含来源、金额、时间）

### 4.2 Agent（贡献者）

- Agent 运行状态：运行中（绿）/ 已停止（灰）
- 启动 / 停止按钮
- 本次在线时长、处理请求数、质量乘数星级
- 实时请求速率折线图（贡献 req/min）

### 4.3 Network（全局网络）

上半部分 — 运营大屏：
- 在线 worker 数、活跃用户数、今日总请求数、今日总 token 数

下半部分 — 在线 worker 列表：
- 列：节点名、模型列表、质量乘数、在线时长
- 只展示公开信息，无需鉴权

### 4.4 Config（配置）

- 服务端地址（server_url）
- 本地 LLM 地址（llm_base_url）及 token
- 支持的模型（逗号分隔）
- 节点名称
- 保存后写入 `~/.llm-agent/config.json`
- 登录/登出：显示当前登录账号，支持切换

---

## 5. 系统托盘

| 状态 | 图标 |
|------|------|
| Agent 运行中 | 绿点图标 |
| Agent 停止 | 灰点图标 |
| 未登录 | 默认图标 |

托盘显示（悬浮或常驻）：
```
↑ 12 req/min   （本机贡献速率）
↓ 8 req/min    （平台消耗速率，仅供参考）
```

右键菜单：启动 Agent / 停止 Agent / 打开主窗口 / 退出

---

## 6. IPC 约定（主进程 ↔ 渲染进程）

| channel | 方向 | 参数 | 说明 |
|---------|------|------|------|
| `agent:start` | renderer→main | — | 启动 agent 子进程 |
| `agent:stop` | renderer→main | — | 终止 agent 子进程 |
| `agent:status` | main→renderer | `{ running: bool }` | 状态变化推送 |
| `config:read` | renderer→main | — | 返回本地 config.json |
| `config:write` | renderer→main | config object | 写入 config.json |

---

## 7. 服务端新增 API

在 `server/user_router.py` 扩展以下接口，均需 Bearer token 鉴权（除 login 和 public 接口外）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/user/login` | 用户名+密码 → 返回 `token` + `worker_key` |
| `GET` | `/user/me` | 当前用户信息 + 积分余额 |
| `GET` | `/user/stats` | 实时速率：`contribute_req_per_min`、`consume_req_per_min` |
| `GET` | `/user/credits/history` | 积分明细（分页，`?page=&limit=`） |
| `GET` | `/public/network` | 全局运营数据 + 在线 worker 列表（公开，无需鉴权） |

现有 `/dashboard` 页面数据通过 `/public/network` 统一提供，客户端直接复用。

---

## 8. 首次使用流程

1. 打开客户端 → 未登录状态 → 引导至 Config 页
2. 输入 server_url + 用户名 + 密码 → 调 `/user/login`
3. 登录成功 → 自动获取 `worker_key` 并写入 `~/.llm-agent/config.json`
4. 跳转 Profile 首页

---

## 9. 不在范围内

- 用户注册（在 Web 端完成）
- 管理员功能（保留在现有 `/admin/ui`）
- 充值/购买积分（跳转 Web）
