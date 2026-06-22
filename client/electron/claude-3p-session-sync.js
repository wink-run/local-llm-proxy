'use strict';
/**
 * 把原生 Claude Desktop 的 **Code 会话索引** 镜像到 3p 实例，
 * 让 Token Bank 接管 Desktop 后能在 3p Code 列表里看到「代理前」的会话。
 *
 * 关键前提（已实测）：3p Code 与原生 Code 的 transcript **同源**——都在 `~/.claude/projects/<cwd>/<cliSessionId>.jsonl`，
 * cwd 是真实项目目录。差异只在「会话索引」：
 *   原生：<Roaming|App Support>/Claude/claude-code-sessions/<真实account>/<org>/local_*.json
 *   3p：  <Local|App Support>/Claude-3p/claude-code-sessions/<虚拟account>/<org>/local_*.json
 * 所以只需复制索引文件（transcript 一字不动），3p Desktop 即可列出并正常打开。
 *
 * 单向：原生 → 3p。增量去重（已存在的跳过）。account/org 动态发现，不写死 uuid。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function nativeCodeSessionsRoot() {
  const home = os.homedir();
  if (process.platform === 'win32')  return path.join(home, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  return path.join(home, '.config', 'Claude', 'claude-code-sessions');
}

function p3CodeSessionsRoot() {
  const home = os.homedir();
  if (process.platform === 'win32')  return path.join(home, 'AppData', 'Local', 'Claude-3p', 'claude-code-sessions');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude-3p', 'claude-code-sessions');
  return path.join(home, '.config', 'Claude-3p', 'claude-code-sessions');
}

const IDX_RE = /^local_.+\.json$/;

/** 在 root 下找会话数最多的 <account>/<org> 目录（取最活跃的那个账号空间）。 */
function findSessionDir(root) {
  let best = null;
  let bestCount = -1;
  let accounts;
  try { accounts = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const acc of accounts) {
    if (!acc.isDirectory()) continue;
    let orgs;
    try { orgs = fs.readdirSync(path.join(root, acc.name), { withFileTypes: true }); } catch { continue; }
    for (const org of orgs) {
      if (!org.isDirectory()) continue;
      const dir = path.join(root, acc.name, org.name);
      let n = 0;
      try { n = fs.readdirSync(dir).filter((f) => IDX_RE.test(f)).length; } catch {}
      if (n > bestCount) { bestCount = n; best = dir; }
    }
  }
  return best;
}

/** 单向镜像 srcDir → dstDir（按索引文件名去重；transcript 同源不动）。 */
function mirror(srcDir, dstDir) {
  let copied = 0;
  let skipped = 0;
  let files;
  try { files = fs.readdirSync(srcDir).filter((f) => IDX_RE.test(f)); } catch { return { copied: 0, skipped: 0 }; }
  for (const f of files) {
    const dst = path.join(dstDir, f);
    if (fs.existsSync(dst)) { skipped++; continue; }
    try { fs.copyFileSync(path.join(srcDir, f), dst); copied++; } catch {}
  }
  return { copied, skipped };
}

/**
 * 单向：原生 → 3p（让 3p Code 列表看到「代理前」会话）。
 * 3p 目标目录靠「3p 已产生过至少一个 Code 会话」定位 account/org；3p 从未用过 Code 时返回 error:'no_3p_dir'。
 */
function syncNativeCodeSessionsTo3p() {
  const srcDir = findSessionDir(nativeCodeSessionsRoot());
  if (!srcDir) return { copied: 0, skipped: 0, error: 'no_native_sessions' };
  const dstDir = findSessionDir(p3CodeSessionsRoot());
  if (!dstDir) return { copied: 0, skipped: 0, error: 'no_3p_dir' };
  return { ...mirror(srcDir, dstDir), source: srcDir, target: dstDir };
}

/**
 * 双向：原生 ↔ 3p。原生→3p 让 3p 看到代理前会话；3p→原生 让代理期间跑的会话切回非接管也能看到。
 * 只同步 Code 索引（claude-code-sessions），transcript 同源（~/.claude/projects）不动。
 * 任一侧目录缺失则跳过该方向，不报错（接管/启动时静默尽力而为）。
 */
function syncCodeSessionsBidirectional() {
  const nativeDir = findSessionDir(nativeCodeSessionsRoot());
  const p3Dir = findSessionDir(p3CodeSessionsRoot());
  const out = { toP3: { copied: 0, skipped: 0 }, toNative: { copied: 0, skipped: 0 }, nativeDir, p3Dir };
  if (!nativeDir || !p3Dir) {
    out.skipped = !nativeDir ? 'no_native_sessions' : 'no_3p_dir';
    return out;
  }
  out.toP3 = mirror(nativeDir, p3Dir);
  out.toNative = mirror(p3Dir, nativeDir);
  return out;
}

// ── A：Cowork 会话注入（实验性，脆弱）────────────────────────────────────────
// Cowork 与 Code 不同：transcript 隔离在各会话独立沙箱（.claude HOME），cwd 把账号/会话 uuid 嵌进路径。
// 所以要整目录搬 + 三处路径改写（encoded 目录名 / jsonl 内 cwd / .claude.json）。Desktop 打开 agent 会话
// 会尝试恢复运行时，未必稳——仅作探针 / 尽力而为。

function nativeCoworkSessionsRoot() {
  const home = os.homedir();
  if (process.platform === 'win32')  return path.join(home, 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
  return path.join(home, '.config', 'Claude', 'local-agent-mode-sessions');
}
function p3CoworkSessionsRoot() {
  const home = os.homedir();
  if (process.platform === 'win32')  return path.join(home, 'AppData', 'Local', 'Claude-3p', 'local-agent-mode-sessions');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude-3p', 'local-agent-mode-sessions');
  return path.join(home, '.config', 'Claude-3p', 'local-agent-mode-sessions');
}

function copyDirRecursive(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name);
    const dp = path.join(d, e.name);
    if (e.isDirectory()) copyDirRecursive(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

// Claude 把工作目录编码成目录名：所有非字母数字字符 → '-'（含 ':' '\' '/' '_'）。
const encodeCwd = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * 把 srcDir 下的一个 Cowork 会话整目录注入 dstDir（含沙箱 transcript + 三处路径改写）。
 * 已存在则跳过（幂等）。返回 true=注入成功 / false=跳过或失败。
 */
function injectCoworkSession(uuid, srcDir, dstDir) {
  const oldSession = path.join(srcDir, uuid);
  const newSession = path.join(dstDir, uuid);
  if (!fs.existsSync(oldSession)) return false;
  if (fs.existsSync(newSession)) return false; // 幂等：目标已有同名会话目录

  const oldEnc = encodeCwd(oldSession + path.sep + 'outputs');
  const newEnc = encodeCwd(newSession + path.sep + 'outputs');
  const oldEsc = JSON.stringify(oldSession).slice(1, -1); // JSON 转义形式（jsonl/json 文本里反斜杠是 \\）
  const newEsc = JSON.stringify(newSession).slice(1, -1);

  copyDirRecursive(oldSession, newSession);

  // 1) 重命名沙箱 transcript 的 encoded 目录（路径变了）
  const projDir = path.join(newSession, '.claude', 'projects');
  try {
    if (oldEnc !== newEnc && fs.existsSync(path.join(projDir, oldEnc))) {
      fs.renameSync(path.join(projDir, oldEnc), path.join(projDir, newEnc));
    }
  } catch {}

  // 2) 改写 jsonl / .claude.json 里的路径引用（转义形式 + 原始形式都替）
  const rewrite = (f) => {
    if (!fs.existsSync(f)) return;
    let t = fs.readFileSync(f, 'utf8');
    t = t.split(oldEsc).join(newEsc).split(oldSession).join(newSession);
    fs.writeFileSync(f, t);
  };
  try { for (const f of fs.readdirSync(path.join(projDir, newEnc))) if (f.endsWith('.jsonl')) rewrite(path.join(projDir, newEnc, f)); } catch {}
  rewrite(path.join(newSession, '.claude', '.claude.json'));

  // 3) 复制 + 改写索引
  try {
    let idx = fs.readFileSync(path.join(srcDir, uuid + '.json'), 'utf8');
    idx = idx.split(oldEsc).join(newEsc).split(oldSession).join(newSession);
    fs.writeFileSync(path.join(dstDir, uuid + '.json'), idx);
  } catch { return false; }
  return true;
}

/** 探针/手动：注入单个原生 Cowork 会话到 3p（省略 uuid 则取第一个）。 */
function injectCoworkSessionTo3p(sessionUuid) {
  const srcDir = findSessionDir(nativeCoworkSessionsRoot());
  const dstDir = findSessionDir(p3CoworkSessionsRoot());
  if (!srcDir) return { error: 'no_native_cowork' };
  if (!dstDir) return { error: 'no_3p_cowork' };
  let uuid = sessionUuid;
  if (!uuid) {
    const first = fs.readdirSync(srcDir).find((f) => /^local_[\w-]+\.json$/.test(f));
    if (!first) return { error: 'no_session' };
    uuid = first.replace(/\.json$/, '');
  }
  return injectCoworkSession(uuid, srcDir, dstDir)
    ? { injected: uuid, from: srcDir, to: dstDir }
    : { error: 'inject_failed_or_exists', uuid };
}

const listSessionUuids = (dir) => {
  try { return fs.readdirSync(dir).filter((f) => /^local_[\w-]+\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')); }
  catch { return []; }
};

/**
 * 双向批量：原生 ↔ 3p Cowork（整目录搬 + 路径改写，增量去重）。
 * 原生→3p 让 3p 看到代理前 Cowork；3p→原生 让代理期间的 Cowork 切回非接管也能看到。
 */
function syncCoworkSessionsBidirectional() {
  const nativeDir = findSessionDir(nativeCoworkSessionsRoot());
  const p3Dir = findSessionDir(p3CoworkSessionsRoot());
  const out = { toP3: 0, toNative: 0, nativeDir, p3Dir };
  if (!nativeDir || !p3Dir) { out.skipped = !nativeDir ? 'no_native_cowork' : 'no_3p_cowork'; return out; }
  for (const uuid of listSessionUuids(nativeDir)) if (injectCoworkSession(uuid, nativeDir, p3Dir)) out.toP3++;
  for (const uuid of listSessionUuids(p3Dir)) if (injectCoworkSession(uuid, p3Dir, nativeDir)) out.toNative++;
  return out;
}

module.exports = {
  syncCodeSessionsBidirectional,
  syncCoworkSessionsBidirectional,
  syncNativeCodeSessionsTo3p,
  injectCoworkSession,
  injectCoworkSessionTo3p,
  nativeCodeSessionsRoot,
  p3CodeSessionsRoot,
  nativeCoworkSessionsRoot,
  p3CoworkSessionsRoot,
  findSessionDir,
};
