'use strict';
/**
 * 通过官方 arkcli CLI 读取 Coding / Agent Plan 额度。
 * 命令：arkcli usage plan --format json（需先 arkcli auth login）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { windowMeta } = require('./volcengine-openapi');

function candidateArkcliBins() {
  const home = os.homedir();
  const fromEnv = process.env.ARKCLI_PATH ? [process.env.ARKCLI_PATH] : [];
  const extras = [
    'arkcli',
    path.join(home, '.local/bin/arkcli'),
    path.join(home, '.arkcli/bin/arkcli'),
    '/usr/local/bin/arkcli',
    '/opt/homebrew/bin/arkcli',
  ];
  return [...fromEnv, ...extras];
}

function resolveArkcliPath() {
  for (const bin of candidateArkcliBins()) {
    if (!bin) continue;
    if (bin === 'arkcli') {
      try {
        execFileSync('which', ['arkcli'], {
          encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        return 'arkcli';
      } catch { continue; }
    }
    try {
      if (fs.existsSync(bin) && fs.statSync(bin).isFile()) return bin;
    } catch { /* ignore */ }
  }
  return null;
}

function periodToWindow(period) {
  if (!period || typeof period !== 'object') return null;
  const meta = windowMeta(period.label || period.Level || period.level || '');
  if (!meta) return null;
  let pct = period.percent;
  if (typeof pct !== 'number' || !isFinite(pct)) {
    const used = Number(period.used);
    const total = Number(period.total);
    if (total > 0 && isFinite(used)) pct = (used / total) * 100;
    else pct = 0;
  }
  let resetsAt = null;
  if (period.reset_at) {
    const t = Date.parse(period.reset_at);
    if (Number.isFinite(t)) resetsAt = new Date(t).toISOString();
  }
  return {
    id: meta.id,
    title: meta.title,
    usedPercent: Math.min(100, Math.max(0, pct)),
    usageKnown: true,
    resetsAt,
    windowMinutes: meta.windowMinutes,
  };
}

/** arkcli JSON → { windows, plan, source, product } */
function mapArkcliUsagePlan(raw) {
  if (!raw || raw.ok === false) {
    const msg = (raw && raw.error && raw.error.message) || 'arkcli 未配置或未登录';
    throw new Error(msg);
  }
  const items = Array.isArray(raw.items) ? raw.items : [];
  const subscribed = items.filter((it) => it && it.subscribed !== false);
  // 优先 coding-plan，其次 agent-plan
  const pick = subscribed.find((it) => /coding/i.test(String(it.product || '')))
    || subscribed.find((it) => /agent/i.test(String(it.product || '')))
    || subscribed[0]
    || items[0];
  if (!pick) throw new Error('arkcli 未返回套餐用量');

  const periods = Array.isArray(pick.periods) ? pick.periods : [];
  const windows = [];
  for (const p of periods) {
    const w = periodToWindow(p);
    if (w) windows.push(w);
  }
  if (!windows.length) throw new Error('arkcli 套餐无可用窗口');

  const product = String(pick.product || '');
  let plan = /agent/i.test(product) ? 'Agent Plan' : 'Coding Plan';
  if (pick.tier) plan = `${plan} · ${pick.tier}`;
  else if (pick.edition) plan = `${plan} · ${pick.edition}`;

  return {
    windows,
    plan,
    source: 'arkcli',
    product,
  };
}

function fetchArkcliUsagePlan(deps = {}) {
  const bin = deps.bin || resolveArkcliPath();
  if (!bin) throw new Error('未找到 arkcli，请安装 @volcengine/ark-cli 并执行 arkcli auth login');
  const out = execFileSync(bin, ['usage', 'plan', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let json;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error('arkcli 输出不是合法 JSON');
  }
  return mapArkcliUsagePlan(json);
}

module.exports = {
  resolveArkcliPath,
  mapArkcliUsagePlan,
  fetchArkcliUsagePlan,
  periodToWindow,
};
