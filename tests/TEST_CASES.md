# Test Cases — designv2 分支

> 截至 2026-05-21 实施完毕后整理。
> 范围：DesignV2 三板块 + P0/M2/Phase A–E 全部新增能力。

## 图例

| 标记 | 含义 |
|---|---|
| ✅ | 已执行通过（含时间 + 方式） |
| 🔄 | 已自动化（可重复跑的脚本/pytest） |
| 📝 | 手工执行（需要人在场点击或粘贴 key） |
| ⏳ | 设计中，尚未执行 |
| ⚠ | 已知会失败（缺依赖 / 仍在 scaffold 阶段） |

按板块/能力分组。每个测试用例 ID 形式：`TC-<板块>-<编号>`。

---

## TC-① 板块① 本地网关

### 后端 API（基础健康度）

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-①-001 | Gateway 启动后 `/__local__/health` 返回 200，含策略/keystore/gateway_url/key_masked | ✅ 2026-05-20 | `curl -s http://127.0.0.1:11435/__local__/health` → `{"ok":true,...}` |
| TC-①-002 | `keystore_backend` 在 Windows 上识别为 `keyring(WinVaultKeyring)` | ✅ 2026-05-20 | health 响应里检查 |
| TC-①-003 | `LOCAL_DB_PATH` 默认指向 `~/.local-llm-proxy/local.db`，不污染 `proxy.db` | ✅ 2026-05-20 | health 响应里 `local_db` 字段 + 文件不存在则自动创建 |

### 路由策略

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-①-101 | 默认策略 `cost` | ✅ | `GET /__local__/strategy` → `{"strategy":"cost"}` |
| TC-①-102 | 切换到 `quality` 持久化 | ✅ | `POST /__local__/strategy {"strategy":"quality"}` 重启后仍是 quality |
| TC-①-103 | 非法策略值返回 422 | ✅ | `POST {"strategy":"invalid"}` → HTTP 422，pydantic pattern 错误 |
| TC-①-104 | `custom` 策略按 `priority` 升序 | ⏳ | 添加两个 priority=10 / priority=20 provider，验候选链顺序 |

### Provider Pool CRUD

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-①-201 | 从 free-catalog 添加 Ollama（无 key）| ✅ | `POST /__local__/providers/from-catalog {"provider_id":"ollama","api_key":""}` |
| TC-①-202 | 添加需要 key 的 Groq 但不传 key 返回 400 | ⏳ | `POST {"provider_id":"groq","api_key":""}` → 400 |
| TC-①-203 | 添加后 key 真的进了 Windows Credential Manager | 📝 | 在 keymgr.msc 里能看到 service=local-llm-proxy |
| TC-①-204 | 删除 provider 同时删除 keystore 中的 key | ⏳ | DELETE 后 `keyring.get_password()` 返回 None |
| TC-①-205 | 同一 provider_id 重复添加（覆盖语义） | ⏳ | 添加两次同 id，第二次 key 应覆盖第一次 |

### Chat Completions 路由 + 故障转移

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-①-301 | unknown model 但有 wildcard provider 时路由到该 provider | ✅ | model `unknown` → 经 Ollama wildcard → 502 ConnectError（Ollama 本机未启动） |
| TC-①-302 | 候选链第一个返回 5xx 时尝试下一个 | ⏳ | mock 两个 provider，第一个 500，验请求实际打到了第二个 |
| TC-①-303 | 候选链全部失败返回 502 + last error | ✅ | unknown model 测试包含此分支 |
| TC-①-304 | 流式 SSE 直通 | ⏳ | 用 mock_llm.py 启 mock provider，stream=true 验证 chunks 不被缓冲 |
| TC-①-305 | 候选链都跳过 4xx（4xx 视为客户端错，不重试） | ⏳ | mock 第一个返回 401，验证不会切换 |

### Test Connection

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-①-401 | Groq 用错误 key → 真实 401 + 错误信息 | ✅ 2026-05-20 | `POST /__local__/test-connection {"provider_id":"groq","api_key":"gsk-invalid"}` → `{"ok":false,"status":401,...}` |
| TC-①-402 | Ollama 本机未启动 → ConnectError | ⏳ | `POST {"provider_id":"ollama","api_key":""}` 期待 ok:false |
| TC-①-403 | Latency 字段在 ms 单位且 < 30s | ✅ | 已观察到 `latency_ms: 503` 合理 |

### Gateway API Key

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-①-501 | 首次启动自动生成 `lp-XXXXX` 并入 gateway_settings | ✅ 2026-05-21 | health 含 `gateway_key_masked`；停启 gateway 后 key 不变 |
| TC-①-502 | `/gateway-key` 返回完整 key | ✅ | `curl /__local__/gateway-key` 含 32+ 字符 key |
| TC-①-503 | `/gateway-key/rotate` 轮换 key 且新值生效 | ⏳ | rotate 后旧 key 在 settings 中消失 |

### prompt-cache 中间件

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-①-601 | 默认请求不走 cache（无 header 无 temp=0） | ⏳ | `POST /v1/chat/completions` 不带 X-LLP-Cache 头，两次相同请求都打上游 |
| TC-①-602 | `temperature=0` 自动启用 cache，第二次命中 | ⏳ | 同一 prompt 第二次响应含 `_llp_cached: true` |
| TC-①-603 | `X-LLP-Cache: on` 显式启用 | ⏳ | header 强制启用，第二次命中 |
| TC-①-604 | 带 `tools` 字段时跳过 cache（即使 temp=0） | ⏳ | 验证 chat with tools 永远不走 cache |
| TC-①-605 | streaming 请求跳过 cache | ⏳ | stream=true 不应触发 put/get |
| TC-①-606 | LRU 淘汰：插入 5001 条后最早的被删 | ⏳ | 单元测试用 prompt_cache.put loop |
| TC-①-607 | TTL 过期后命中失败 | ⏳ | 设 TTL=1s，sleep 2s，验 get 返回 None |
| TC-①-608 | 单条 > 256KB 的响应不入 cache | ⏳ | put 大 payload 应返回 False |
| TC-①-609 | `/cache/stats` 与 `/cache/clear` 端点 | ✅ 2026-05-21 | stats 返回 `entries/total_bytes/total_hits` |

---

## TC-② 板块② Provider 接入

### Layer 1（免费源目录）

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-②-101 | `/free-catalog` 返回 5 条（Ollama/Groq/Cerebras/Gemini AI Studio/OpenRouter free）+ guide_text 内联 | ✅ 2026-05-20 | 验证 5 个 id + groq.guide_text 首行 == "# Groq Cloud ..." |
| TC-②-102 | `~/.local-llm-proxy/free_providers.user.yaml` 存在时覆盖内置 | ⏳ | 写一份用户 yaml 后 free-catalog 应反映 |
| TC-②-103 | Onboarding Layer 1 标签：未接入态展示黄色提示 | 📝 | UI 验证 |
| TC-②-104 | 单卡「测试连接」流程（粘贴 → POST → 显示绿/红） | 📝 | 用真实 Groq key 走一次 |

### Layer 2（订阅/付费目录）

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-②-201 | `/paid-catalog` 返回 8 条 | ✅ 2026-05-21 | 含 OpenAI/Anthropic/DeepSeek/智谱/Moonshot/OpenRouter/Claude Pro/ChatGPT Plus |
| TC-②-202 | `requires_p1` 标记的条目 UI 显示「需 P1」橙色徽章 + 接入按钮 disabled | 📝 | Claude Pro / ChatGPT Plus 卡 |
| TC-②-203 | `affiliate=true` 显示「优惠」粉色徽章 | ⏳ | 当前 paid_providers.yaml 全为 false，未来加 affiliate 时验证 |

### cc-switch 一次性导入

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-②-301 | `/ccswitch/available` 检测 `~/.cc-switch/cc-switch.db` 存在性 | ✅ 2026-05-21 | 本机未装 cc-switch 返回 `available:false` |
| TC-②-302 | 装了 cc-switch 时 `/ccswitch/import` 读 db 写入 user.yaml | ⏳ | 装 cc-switch + 配置几个 provider → 调 import → 验 `paid_providers.user.yaml` 写入 + `imported_from:cc-switch` |
| TC-②-303 | 二次导入合并而非覆盖（id 冲突保留新） | ⏳ | 调两次 import 验证 user.yaml |

### Layer 3（分享池占位）

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-②-401 | `/share-pool` 当前返回 available:false + 提示 | ✅ 2026-05-21 | 返回 `available:false, notice: "分享池需要..."` |
| TC-②-402 | 接通 VPS 后 share-pool 返回真实条目 | ⏳ | 待 P2 阶段接通 |

---

## TC-③ 板块③ 服务贡献

### 三层 source_kind CRUD

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-③-101 | `/contribute/sources` 默认空列表 + advanced_mode:false | ✅ 2026-05-21 | 启动后第一次调用应符合 |
| TC-③-102 | 添加 local 类型不需要高级模式 | ⏳ | `POST {"source_kind":"local","display_name":"my ollama"}` → 200 |
| TC-③-103 | 添加 gateway 类型不需要高级模式 | ⏳ | 公司内 OneAPI URL → 200 |
| TC-③-104 | 添加 subscription 类型在 advanced=false 时返回 403 | ⏳ | `POST {"source_kind":"subscription",...}` → 403 |
| TC-③-105 | toggle / delete 端点 | ⏳ | 添加后切换 enabled，再删除 |

### 高级模式 + ToS Ack

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-③-201 | `/advanced-mode/text` 返回 4 条具体风险声明 | ⏳ | response 含「4 条具体风险」+「ToS」+「封号」关键词 |
| TC-③-202 | `enable` 不带 ack:true 返回 400 | ⏳ | `POST {"ack":false}` → 400 |
| TC-③-203 | `enable` 带 ack:true 后写入 tos_acks 表 | ⏳ | enable 后 `/contribute/tos-acks` 含 action=enable_advanced |
| TC-③-204 | enable 后再添加 subscription 类型成功 | ⏳ | 接 TC-③-104 |
| TC-③-205 | `disable` 也写 ack 记录（disable 不需要 ack:true） | ⏳ | disable 后 ack 列表含 disable_advanced |
| TC-③-206 | 关闭高级模式后已存在的 subscription source 数据保留 | ⏳ | DB 行不删，UI section 隐藏 |

### Contribute UI（手工）

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-③-301 | 默认显示「本地算力 / 私有网关」两个 section | 📝 | UI 验证 |
| TC-③-302 | 点「启用高级模式」弹窗显示风险声明 + 必须勾选才能继续 | 📝 | 勾选前 button disabled |
| TC-③-303 | 启用后第三个 section「⚠ 富余订阅 key」出现 | 📝 | UI 验证 |
| TC-③-304 | 「添加贡献源」弹窗在 advanced=false 时下拉无 subscription 选项 | 📝 | UI 验证 |

---

## TC-M2 板块① Path B 一键写入器

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-M2-001 | `/apps` 列出 8 个工具 + format badge | ✅ 2026-05-21 | curl 返回数组长度 8 |
| TC-M2-002 | claude_code preview 显示 before/after env diff | ✅ 2026-05-20 | `GET /apps/claude_code/preview?preferred_model=...` 返回 before/after |
| TC-M2-003 | **写入保留用户字段** —— `MODELS`/`mcpServers`/`theme`/`CUSTOM_USER_FIELD` 都被 backfill 保留 | ✅🔄 2026-05-21 | `tests/test_app_writers.py::test_backfill_preserves_user_fields` |
| TC-M2-004 | **atomic write** —— 写入前后 tmpfile 已清理 | ✅🔄 | 同上脚本验证目标文件已写、tmp 清理 |
| TC-M2-005 | **自动备份** —— 写入前原文件复制到 backups/{tool}-{ISO8601}.{ext} | ✅🔄 | 同上脚本验证 backup_path 存在且内容匹配旧文件 |
| TC-M2-006 | backup 最多保留 10 份（轮转） | ⏳🔄 | 模拟 12 次写入，验 BACKUP_KEEP=10 |
| TC-M2-007 | preferred_model 写入 ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS 三个 env | ✅🔄 | 同 TC-M2-003 同时验三个 model env |
| TC-M2-008 | Codex 写入 TOML `[model_providers.local-llm-proxy]` + 标 needs_env_var=true | ⏳ | `POST /apps/codex/write` 后读 `~/.codex/config.toml` 验 |
| TC-M2-009 | Cursor 写 JSON `cursor.openaiApiKey` 等三个字段 | ⏳ | 模拟空配置，写后验证 3 个 key |
| TC-M2-010 | Continue 在已有 models 数组中按 title 去重 | ⏳ | 预填一个 title=Local LLM Proxy 的旧条目，写后只剩一个 |
| TC-M2-011 | OpenCode 写嵌套 `provider.openai.{baseURL,apiKey}` | ⏳ | |
| TC-M2-012 | unknown app 返回 404 | ⏳ | `POST /apps/foobar/write` → 404 |
| TC-M2-013 | 损坏的现有 JSON 返回错误而非静默清空 | ⏳ | 预填非法 JSON，验 write 返回 ok:false + 错误信息 |
| TC-M2-014 | 写入后 `app_bindings` 表 upsert 含 last_written_at + masked key | ⏳ | `/apps` 返回的 binding 字段 |
| TC-M2-015 | DELETE `/apps/{name}/binding` 仅清 DB 不撤销文件 | ⏳ | delete 后文件内容仍是写入后的版本 |

### Apps UI（手工）

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-M2-101 | 顶部 Gateway URL + Key 默认脱敏，点「显示完整 key」后 reveal | 📝 | UI 验证 |
| TC-M2-102 | 「复制」按钮 navigator.clipboard 真的填入剪贴板 | 📝 | UI + 粘贴验证 |
| TC-M2-103 | 「轮换」按钮二次确认 + 新 key 生效 | 📝 | UI |
| TC-M2-104 | 单卡「预览 diff」并排 before/after JSON | 📝 | UI |
| TC-M2-105 | 「写入配置」浏览器 confirm + 成功后显示备份路径 | 📝 | UI |
| TC-M2-106 | Codex 卡 needs_env_var 提示 + `export` 行（含真实 key） | 📝 | UI |

---

## TC-Electron Electron 集成

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-EL-001 | npm run dev 启动后 gateway 自动孵化 | ✅ 2026-05-21 | 日志含 `[gateway-process] Spawning: python -m uvicorn ...` |
| TC-EL-002 | 1.5 秒后健康探测 ALIVE | ✅ 2026-05-21 | 日志 `Health probe: ALIVE` |
| TC-EL-003 | 端口 11435 被外部进程占用时 Electron 跳过自启 | ✅ 2026-05-20 | 先 uvicorn 手启，再 npm dev，日志含 `already running externally` |
| TC-EL-004 | 子进程崩溃后 2 秒自动重启，最多 3 次 | ⏳ | kill -9 后看日志 |
| TC-EL-005 | Electron quit 时 gateway 子进程被清理（端口释放） | ⏳ | 关闭 Electron 后 netstat 不见 11435 |
| TC-EL-006 | 托盘菜单显示 Gateway: 运行中 (127.0.0.1:11435) | 📝 | 右键托盘图标 |
| TC-EL-007 | 托盘「停止 Gateway / 启动 Gateway」可用 | 📝 | UI |
| TC-EL-008 | Python 不在 PATH 时显示清晰错误 + 提示 LLP_PYTHON env | ⏳ | rename python.exe 后 npm dev，验日志 |

---

## TC-CORS / 跨域

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-CORS-001 | Origin: http://localhost:5173 (vite dev) 可访问网关 | ✅ 2026-05-21 | curl -H "Origin: ..." 验 `access-control-allow-origin: *` |
| TC-CORS-002 | Electron renderer (file://) 可访问网关 | 📝 | 实际启动验证 |

---

## TC-P1 P1 订阅层 scaffold

| ID | 用例 | 状态 | 命令 / 期望 |
|---|---|---|---|
| TC-P1-001 | `/subscription/platforms` 返回 3 个平台 + status=scaffold-only | ✅ 2026-05-21 | 含 claude_pro / chatgpt_plus / gemini_advanced |
| TC-P1-002 | 实际 dispatch 抛 NotImplementedError | ⚠ 预期失败 | scaffold 阶段不实现 |
| TC-P1-003 | `subscription_providers` 表创建成功 | ✅ | 启动时 init_subscription_db 调用 |

---

## 自动化测试（pytest）

| 文件 | 覆盖 |
|---|---|
| `tests/test_app_writers.py` | TC-M2-003 / 004 / 005 / 007（backfill / atomic / backup / preferred_model） |
| `tests/mock_llm.py` | （已存在）通用 mock 上游 LLM，可用于 TC-①-302/304/305 故障转移测试 |
| `tests/mock_image_llm.py` | （已存在）mock 图像生成 |

### 运行方式

```bash
cd local-llm-proxy
pip install pytest
python -m pytest tests/ -v
```

---

## 测试覆盖率快照（2026-05-21）

| 板块 / 能力 | ✅ 已验证 | ⏳ 待补 | ⚠ 已知 fail |
|---|---|---|---|
| 板块① 后端 API | 14 | 12 | 0 |
| 板块② Layer 1/2/3 | 5 | 5 | 0 |
| 板块③ 三层 + 高级模式 | 1 | 9 | 0 |
| M2 一键写入器 | 7 | 8 | 0 |
| Electron 集成 | 3 | 5 | 0 |
| P1 订阅层 | 2 | 0 | 1（预期，未实现） |
| **合计** | **32** | **39** | **1** |

---

## 下一步推荐补的高价值用例

按"如果挂了用户立刻感知 / 数据丢失 / 回滚困难"排序：

1. **TC-M2-010 / 013** —— Continue 去重 + 损坏 JSON 错误处理（避免误覆盖用户已有 model 列表）
2. **TC-③-202 / 203** —— ack 流程入库（合规审计依赖）
3. **TC-EL-004 / 005** —— 子进程重启 + 退出清理（避免泄端口 / 僵尸进程）
4. **TC-①-302 / 305** —— 候选链 5xx 故障转移 + 4xx 不重试（核心路由正确性）
5. **TC-①-601…608** —— prompt-cache 边界条件（误命中代价大）
