# Token Bank 隐私政策 / Privacy Policy

**生效日期 / Effective date：2026-07-21**  
**适用产品：** Token Bank（Bundle ID：`run.wink.tokenbank.app`）及同品牌桌面 / CLI 客户端  
**运营方：** lee wink / wink-run（下称「我们」）  
**联系：** [GitHub Issues](https://github.com/wink-run/local-llm-proxy/issues) · 邮箱可在 App Store Connect 支持信息中另行公布

本文同时提供中文与英文；若理解不一致，以中文为准（面向中国大陆用户的 Mac App Store 版本）。

---

## 一、我们如何理解「隐私」

Token Bank 是运行在你电脑上的**本地 AI 网关与 Token 管家**。设计原则是：

1. **本地优先**：上游 API Key、网关配置、会话补录等默认保存在本机；  
2. **可选择上云**：仅在你登录账号、启用云端同步 / 社区分享相关功能时，才向我们的服务端传输必要数据；  
3. **密钥不上云**：上游供应商的 API Key / 访问令牌原文不会上传到我们的服务器；  
4. **不出售数据**：我们不会向广告商或数据经纪商出售你的个人信息。

---

## 二、我们可能处理的信息

### 2.1 仅保存在本机的信息（默认不上传）

| 类型 | 说明 |
|------|------|
| 上游 API Key / OAuth 令牌 | 存于本机配置目录（如 `~/.tokenbank` 等），用于向你指定的模型服务商发起请求 |
| 本地网关配置与路由规则 | 端口、供给链、场景路由、纳管状态等 |
| 本地用量与 Trace | 调用次数、Token、延迟、费用估算、会话补录结果等，先写本机数据库 / 文件 |
| 工作画像与资源资产 | 个性化推荐产生的画像、已纳管 MCP / Skill / Prompt 等（未登录时仅本机） |

上述数据由你控制；卸载应用或删除本机目录即可清除（具体路径见应用内说明）。

### 2.2 你主动登录后可能上传的信息

仅在你**登录 Token Bank 账号**或主动使用云端 / 社区分享功能时：

| 类型 | 说明 | 目的 |
|------|------|------|
| 账户标识 | 账号、邮箱或等价登录标识、会话令牌（JWT） | 认证、多端同步 |
| 设备信息 | 设备 ID、设备名称、系统平台、应用版本、在线心跳 | 多设备盘点、在线状态 |
| 用量汇总快照 | 按 1 / 7 / 30 天等聚合的调用量、Token、费用估算、应用 / 模型排行、压缩节省等**统计摘要**（非完整对话原文） | 多设备合并展示 |
| 账户与订阅摘要 | 你登记的 APP / API / 按量配置的**摘要或指纹**（凭证原文不上报） | 跨端对照与配置同步 |
| 社区分享相关 | 贡献节点登记信息（如模型名、节点名称、worker 标识等，不含上游 Key 原文） | 积分、分享网络运行 |
| 诊断日志（如开启） | 有限的错误 / 连接诊断信息 | 故障排查 |

### 2.3 我们不会故意收集的信息

- 你与各 AI 模型对话的**完整原文内容**（网关仅在本机转发；我们不以「训练大模型」为目的收集对话正文）；  
- 通讯录、相册、精确持续定位、麦克风 / 摄像头内容（应用不为此申请无关权限）；  
- 未成年人专门画像（本产品面向具备完全民事行为能力的开发者与专业用户）。

> 说明：若你将流量路由到**第三方模型服务商**（如 OpenAI、Anthropic、Groq 等）或社区分享节点，对方可能按其自身隐私政策处理请求内容。请分别阅读并遵守其条款。

### 2.4 本地网络与系统能力

应用需在本机监听端口、访问网络，以便：

- 作为本地网关转发你发起的 AI 请求；  
- 在你启用时连接我们的云端服务、更新供给目录、完成登录与同步。

macOS 可能提示网络或文件访问授权；拒绝部分授权可能导致对应功能不可用，但不影响你卸载应用。

---

## 三、我们如何使用信息

在适用法律允许的范围内，我们使用上述信息用于：

1. 提供、维护、改进 Token Bank 的核心功能（纳管、Trace、路由、盘点、推荐、社区分享等）；  
2. 多设备用量聚合与配置同步；  
3. 账户安全、防滥用、故障诊断；  
4. 履行法律法规要求或回应合法请求。

我们**不会**将个人信息用于与产品无关的第三方广告定向投放。

---

## 四、共享、委托与跨境

1. **不出售**：不出售个人信息。  
2. **服务托管**：云端功能可能由我们自有或委托的云基础设施处理；受托方仅可在提供服务所必需的范围内处理数据，并受合同约束。  
3. **第三方模型 / 节点**：你主动选择的上游供应商或社区分享节点独立控制其服务；其处理活动适用其政策。  
4. **法律要求**：在法律法规、诉讼、监管要求的必要范围内，我们可能披露信息。  
5. **跨境**：若你使用部署在境外的云端节点或上游服务，数据可能发生跨境传输；请谨慎选择服务地址与供应商。

---

## 五、存储期限与安全

- **本机数据**：由你保管；我们无法远程删除你电脑上的本地文件。  
- **云端数据**：在账号存续期间为提供服务而保存；你可申请注销账号并删除云端侧与你关联的账户数据（法律法规另有规定或存在未决纠纷的除外）。  
- 我们采取合理的技术与管理措施保护数据，但互联网环境无法保证绝对安全，请妥善保管账号与本机密钥。

---

## 六、你的权利

在适用法律下，你有权：

- 访问、更正、导出与你账号相关的云端信息；  
- 撤回云端同步 / 社区分享等授权（退出登录、关闭相关功能）；  
- 删除本机数据或申请删除云端账户数据；  
- 通过文首渠道联系我们行使权利。

我们将在合理期限内响应；为保障安全，可能需要验证你的身份。

---

## 七、儿童隐私

本产品不以儿童为服务对象。若我们发现在未经监护人同意的情况下收集了儿童个人信息，将尽快删除。

---

## 八、政策更新

我们可能适时更新本政策。重大变更将通过应用内提示、版本说明或项目主页告知。更新后继续使用，即表示你已了解更新内容（法律另有要求的除外）。

---

## 九、App Store 隐私标签摘要（便于填写）

| 类别 | 是否收集 | 说明 |
|------|----------|------|
| 联系信息（邮箱等） | 登录时 | 用于账号 |
| 标识符（设备 ID） | 登录后 | 多设备盘点 |
| 使用数据（用量统计摘要） | 登录后可选 / 同步时 | 非对话全文 |
| 诊断 | 可能 | 排错所需 |
| 敏感信息 / 财务信息 / 健康 | 否 | — |
| 用于追踪跨 App 广告 | 否 | — |
| API Key 上传给我们 | 否 | 仅本机 |

---

# Privacy Policy (English)

**Effective date: 2026-07-21**  
**Product:** Token Bank (Bundle ID `run.wink.tokenbank.app`) and related desktop/CLI clients  
**Operator:** lee wink / wink-run (“we”, “us”)  
**Contact:** [GitHub Issues](https://github.com/wink-run/local-llm-proxy/issues)

## 1. Principles

Token Bank is a **local AI gateway** on your Mac. We design for:

1. **Local-first** storage of API keys, gateway config, and traces;  
2. **Cloud only when you opt in** by signing in or enabling sync / community sharing;  
3. **No upstream API key plaintext** uploaded to our servers;  
4. **No sale** of personal data to advertisers or brokers.

## 2. Data we may process

**On-device only (default):** upstream API keys/tokens, gateway routing config, local usage/trace databases, work portraits and managed resources.

**After you sign in (as needed to provide the feature):** account identifiers and session tokens; device ID/name/platform/app version and heartbeats; aggregated usage snapshots (counts, tokens, cost estimates, rankings—not full chat transcripts); subscription/config summaries or fingerprints (credentials hashed/not uploaded in plaintext); community-sharing node metadata (e.g. model names—not upstream keys); limited diagnostics if enabled.

**We do not intentionally collect:** full conversation content for our own model training; contacts, photos, precise continuous location, mic/camera content for unrelated features.

Requests you route to **third-party model providers** or community-sharing nodes are governed by those parties’ policies.

## 3. How we use data

To provide and improve Token Bank (onboarding, trace, routing, analytics, recommendations, community sharing), multi-device sync, security/abuse prevention, troubleshooting, and legal compliance. We do not use personal data for unrelated third-party ad targeting.

## 4. Sharing

We do not sell personal data. Cloud hosting providers may process data under instruction; third-party model/node operators act independently; disclosure may occur when required by law.

## 5. Retention & security

On-device data is under your control. Cloud data is kept while your account is active to provide the service; you may request account deletion subject to legal exceptions. We use reasonable safeguards; no method is 100% secure.

## 6. Your choices

Access/correct cloud data; sign out or disable sync/sharing; delete local data; request deletion of cloud account data via the contact above.

## 7. Children

Not directed at children. We will delete children’s data if collected inadvertently without proper consent.

## 8. Changes

We may update this policy and will notify via in-app notice, release notes, or the project site for material changes.

---

**公开托管建议：** 将本文件发布为可公网访问的 URL（例如项目 Pages，或 `https://你的服务域名/privacy`），并在 App Store Connect → App 隐私 / App 信息中填写该链接。
