# 积分余额实时显示设计文档

> 状态：已批准，待实现
> 日期：2026-05-20

---

## 1. 目标

在 Sidebar 左下角用户卡片处实时显示当前登录用户的积分余额，每 30 秒自动刷新。

## 2. 范围

- 仅修改两个客户端文件：`AuthContext` 和 `Sidebar`
- 无服务端改动，复用现有 `/user/profile` 接口
- 积分数据字段：`user.credits_balance`（已在 profile API 响应中返回）

## 3. 架构

```
AuthProvider (store/index.jsx)
  └── setInterval(refreshUser, 30_000)   ← 新增，用户登录后启动
        └── GET /user/profile
              └── setUser(r.data)         ← 更新 user.credits_balance

Sidebar.jsx
  └── useAuth() → user.credits_balance   ← 直接读，无新 state
        └── 显示在用户卡片 email 下方
```

## 4. 变更细节

### 4.1 `client/src/store/index.jsx`

在 `AuthProvider` 的 `useEffect` 中，profile 加载成功后（`setUser` 之后）启动定时器：

```js
useEffect(() => {
  const token = localStorage.getItem('token');
  if (!token) { setLoading(false); return; }
  getProfile()
    .then((r) => {
      setUser(r.data);
      // 启动 30s 轮询
      const id = setInterval(() => {
        getProfile().then((r) => setUser(r.data)).catch(() => {});
      }, 30_000);
      return id;
    })
    .catch(() => { localStorage.removeItem('token'); })
    .finally(() => setLoading(false));
}, []);
```

注意：需要用 ref 或闭包保存 interval id 以便在 `loginSuccess` / `logout` 时也能正确清理。

**完整逻辑：**
- 用户已登录（有 token）且 profile 加载成功 → 启动定时器
- 用户登出（`logout()`）→ 清除定时器
- 用户登录（`loginSuccess()`）→ 启动定时器
- 组件卸载 → 清除定时器
- 定时器内的请求失败 → 静默忽略（不改变当前余额显示）

定时器 id 用 `useRef` 存储，避免每次渲染重置。

### 4.2 `client/src/components/Sidebar.jsx`

在用户卡片的 `email` 段下方新增积分行：

```jsx
<p className="text-xs text-gray-400 dark:text-gray-500 truncate">{user.email}</p>
{user.credits_balance != null && (
  <p className="text-xs font-medium text-blue-500 dark:text-blue-400 mt-0.5">
    💎 {Number(user.credits_balance).toLocaleString()} 积分
  </p>
)}
```

- `credits_balance != null` 守卫：防止 profile 首次加载前闪烁空行
- `toLocaleString()`：自动千位分隔符
- 字体色用 `text-blue-500`：与应用蓝色主题保持一致，深色模式用 `text-blue-400`

## 5. 错误处理

| 场景 | 处理方式 |
|------|----------|
| 定时器请求失败（网络断开）| 静默忽略，显示上次成功的余额 |
| `credits_balance` 为 null/undefined | 条件渲染，不显示积分行 |
| 用户登出 | 清除定时器，`user` 置 null，Sidebar 整体不渲染 |

## 6. 不在范围内

- 积分变化动画（数字跳动）
- 余额不足警告
- 手动刷新按钮
- 服务端推送（WebSocket）
