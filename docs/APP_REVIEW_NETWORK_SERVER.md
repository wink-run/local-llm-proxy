# App Review：`com.apple.security.network.server` 说明

自动化拒审文案大意：声明了 `network.server`，但扫描未发现对应「监听入站连接」功能。

**不要删除该 entitlement。** Token Bank 在沙箱内必须对本机端口 `listen`，仅保留 `network.client` 会导致本地网关无法启动。

正确做法：在 App Store Connect → 对应版本 → **App Review Information（审核备注）** 粘贴下文，并在 Resolution Center **回复**同一说明后重新提交（一般无需改二进制；若已改 entitlements 注释则重建上传亦可）。

---

## 英文（推荐粘贴到 App Review Information / Reply）

```
Why we need com.apple.security.network.server

Token Bank is a local AI gateway / agent hub for macOS. On launch it binds HTTP servers on loopback (127.0.0.1) and accepts incoming connections from other apps on the same Mac (CLI tools, IDEs, MCP clients). This is not a public internet server.

Concrete listeners in the Mac App Store build:

1) OpenAI-compatible Local Gateway — http.Server listen on 127.0.0.1:11430 (see client/electron/local-gateway.js, started from electron/main.js). External tools send chat/completions requests to this local endpoint; the app then makes outbound calls to upstream model providers (those use network.client).

2) MCP Gateway — HTTP listener on 127.0.0.1 (client/electron/mcp-gateway-server.js) so MCP-capable clients can connect to routed MCP servers through Token Bank.

3) Agent Dispatch HTTP — ephemeral listen on 127.0.0.1 (client/electron/agent-dispatch-server.js) for local agent orchestration callbacks.

How to verify during review:

1. Install and open Token Bank.
2. Open Gateway / Providers (or equivalent) and confirm the local endpoint is shown, e.g. http://127.0.0.1:11430.
3. From Terminal on the review Mac: curl -sS http://127.0.0.1:11430/v1/models  (or the port shown in-app). A response from the app’s local server demonstrates inbound accept/listen behavior that requires network.server under App Sandbox.

We only use Incoming Connections (Server) for localhost services that are core product functionality. Outgoing Connections (Client) alone is insufficient for listen/accept in the sandbox.
```

---

## 中文（可选，回复审核时可用）

```
为何需要 com.apple.security.network.server

Token Bank 是 macOS 上的本地 AI 网关 / Agent 中枢。启动后会在本机回环地址（127.0.0.1）绑定 HTTP 服务，并接受同一台 Mac 上其他应用（CLI、IDE、MCP 客户端）发起的入站连接。这不是对公网开放的服务器。

MAS 构建中的具体监听：

1) OpenAI 兼容本地网关 — 在 127.0.0.1:11430 listen（local-gateway.js，由 main.js 启动）。外部工具把请求打到该本地端点；应用再出站调用上游模型（出站使用 network.client）。

2) MCP 网关 — 在 127.0.0.1 上 HTTP listen（mcp-gateway-server.js），供 MCP 客户端接入。

3) Agent 派发 HTTP — 在 127.0.0.1 动态端口 listen（agent-dispatch-server.js）。

审核验证建议：打开应用查看本地 Gateway 地址（如 http://127.0.0.1:11430），在终端执行 curl http://127.0.0.1:11430/v1/models，即可确认存在需 sandbox「Incoming Connections」权限的 listen/accept 行为。
```

---

## 操作清单

1. App Store Connect → 你的 Mac 应用 → 当前版本 → **App Review Information** → Notes：粘贴英文说明  
2. Resolution Center 对该拒审消息 **Reply**：粘贴同一英文说明  
3. 重新提交审核（二进制可不变；若只更新了备注也可直接 resubmit）  
4. **不要**从 `client/electron/entitlements.mas.plist` 删除 `com.apple.security.network.server`
