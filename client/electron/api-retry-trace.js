// 追踪 Claude Code「API 重试」与本地网关路由日志的差异
// 日志文件：~/.tokenbank/api-retry-trace.log（JSONL，一行一条）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TRACE_FILE = path.join(os.homedir(), '.tokenbank', 'api-retry-trace.log');
/** 与 api_retry 事件关联的网关路由窗口（毫秒） */
const CORRELATION_WINDOW_MS = 90_000;

function appendTrace(kind, payload) {
  try {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    const rec = { ts: new Date().toISOString(), kind, ...payload };
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify(rec)}\n`);
    console.log(`[api-retry-trace] ${kind}`, JSON.stringify(payload).slice(0, 800));
  } catch (e) {
    console.warn('[api-retry-trace] write failed:', e.message);
  }
}

/** 取时间窗口内的路由日志（getLog 默认 newest-first） */
function correlateRouteLogs(getLog, sinceMs = CORRELATION_WINDOW_MS) {
  const cutoff = Date.now() - sinceMs;
  try {
    const logs = typeof getLog === 'function' ? getLog() : [];
    return logs.filter(e => (e.ts || 0) >= cutoff);
  } catch {
    return [];
  }
}

/** 分析：为何 CLI 报 api_retry 但路由页看不到失败 */
function analyzeCorrelation(routeLogs) {
  const errors = routeLogs.filter(e => e.status === 'error');
  const ok = routeLogs.filter(e => e.status === 'ok');
  const hints = [];
  if (errors.length === 0 && ok.length > 0) {
    hints.push('路由日志仅有成功：可能是网关内部 failover 吞掉上游失败（中间 provider 错误未写入 route log）');
  }
  if (errors.length === 0 && ok.length === 0) {
    hints.push('时间窗口内无网关请求：Claude Code 可能直连官方 API，或请求未经过本地网关');
  }
  if (errors.length > 0) {
    hints.push('路由日志有失败记录，请对照 error / provider_errors 字段');
  }
  return {
    window_ms: CORRELATION_WINDOW_MS,
    total: routeLogs.length,
    errors: errors.length,
    ok: ok.length,
    recent_errors: errors.slice(0, 5),
    recent_ok: ok.slice(0, 3),
    hints,
  };
}

/** Claude CLI stream-json 上报 api_retry */
function traceCliApiRetry({ taskId, agentId, rawLine, step, getRouteLog, spawn_diag: spawnDiag = null }) {
  let raw = null;
  try { raw = JSON.parse(String(rawLine || '').trim()); } catch { /* ignore */ }
  const routeLogs = correlateRouteLogs(getRouteLog);
  appendTrace('claude_cli_api_retry', {
    taskId,
    agentId,
    attempt: step?.attempt,
    max_retries: step?.max_retries,
    error_status: step?.error_status ?? null,
    retry_delay_ms: step?.retry_delay_ms ?? null,
    message: step?.message || step?.content || null,
    raw_event: raw,
    spawn_diag: spawnDiag,
    route_correlation: analyzeCorrelation(routeLogs),
  });
}

/** 网关尝试某 provider 失败（含 failover 中间态，不一定出现在 route log） */
function traceGatewayProviderFail(ctx) {
  appendTrace('gateway_provider_fail', {
    ...ctx,
    note: ctx.will_failover
      ? '上游失败但将继续 failover；若后续成功，route log 仅记录最终 ok'
      : '上游失败且无后续 provider',
  });
}

/** 网关向客户端返回错误响应 */
function traceGatewayClientError(ctx) {
  appendTrace('gateway_client_error', ctx);
}

function traceAgentSpawnEnv(ctx) {
  appendTrace('agent_spawn_env', ctx);
}

module.exports = {
  TRACE_FILE,
  CORRELATION_WINDOW_MS,
  traceCliApiRetry,
  traceGatewayProviderFail,
  traceGatewayClientError,
  traceAgentSpawnEnv,
  correlateRouteLogs,
  analyzeCorrelation,
};
