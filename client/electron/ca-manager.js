// client/electron/ca-manager.js
// CA 来源管理（ca_ref：auto/file）+ 动态签发叶子证书。
//   - auto：自动生成 name-constrained CA，约束域名 = config-loader.mitmDomains() 并集
//   - file://：用用户指定的 CA（需含私钥才能签叶子）
// CA 与叶子缓存在 ~/.tokenbank；私钥本地永不外传。复用本机已验证的 openssl 调用方式。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');
const configLoader = require('./config-loader');

const TB_DIR   = path.join(os.homedir(), '.tokenbank');
const CA_DIR   = path.join(TB_DIR, 'ca');
const LEAF_DIR = path.join(CA_DIR, 'leaf');
const CA_CRT   = path.join(CA_DIR, 'ca.crt');
const CA_KEY   = path.join(CA_DIR, 'ca.key');
const CA_META  = path.join(CA_DIR, 'ca.meta.json');   // 记录约束域名，判断是否需重签

function ensureDirs() {
  for (const d of [TB_DIR, CA_DIR, LEAF_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// openssl 调用封装（Windows git-bash 需 MSYS2_ARG_CONV_EXCL 防路径转换）
function openssl(args, opts = {}) {
  return execFileSync('openssl', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' },
    ...opts,
  });
}

// ── 生成 name-constrained CA（auto 模式）─────────────────────────────────────
function generateConstrainedCA(domains) {
  ensureDirs();
  const cnfPath = path.join(CA_DIR, 'ca.cnf');
  // 多域名约束用 @nc 节引用（本机已验证此写法正确解析多个）
  const ncLines = domains.map((d, i) => `permitted;DNS.${i}=${d}`).join('\n');
  const cnf = `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=TokenBank Local CA
[ext]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
${domains.length ? 'nameConstraints=critical,@nc' : ''}
${domains.length ? '[nc]' : ''}
${ncLines}
`;
  fs.writeFileSync(cnfPath, cnf);
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', CA_KEY, '-out', CA_CRT, '-days', '3650', '-config', cnfPath]);
  fs.writeFileSync(CA_META, JSON.stringify({ domains: domains.slice().sort(), mode: 'auto' }));
  // 私钥权限收紧（best-effort）
  try { fs.chmodSync(CA_KEY, 0o600); } catch {}
  return { crt: CA_CRT, key: CA_KEY };
}

// 当前约束域名是否和 yaml 一致；不一致需重签
function caMatchesDomains(domains) {
  if (!fs.existsSync(CA_CRT) || !fs.existsSync(CA_META)) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(CA_META, 'utf8'));
    if (meta.mode !== 'auto') return false;
    const a = (meta.domains || []).slice().sort();
    const b = domains.slice().sort();
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}

// ── 公开：确保 CA 就绪，返回 CA 证书路径（供 NODE_EXTRA_CA_CERTS）──
// 按 ca_ref 解析链：file:// 优先用用户的，否则 auto 自动生成。
function ensureCA() {
  ensureDirs();
  const ref = configLoader.resolveRef(configLoader.caRef(), configLoader.gatewayCtx());

  if (ref && ref.kind === 'file') {
    // 用户指定 CA：直接用其证书路径（签叶子时需对应私钥，约定同名 .key 或用户自管）
    configLoader.setCaPath(ref.value);
    return { crt: ref.value, key: guessKeyForUserCA(ref.value), mode: 'file' };
  }

  // auto：约束域名 = yaml mitmDomains 并集
  const domains = configLoader.mitmDomains();
  if (!caMatchesDomains(domains)) {
    generateConstrainedCA(domains);   // 域名变了/不存在 → 重签
  }
  configLoader.setCaPath(CA_CRT);
  return { crt: CA_CRT, key: CA_KEY, mode: 'auto', domains };
}

function guessKeyForUserCA(crtPath) {
  const cand = crtPath.replace(/\.(crt|pem|cer)$/i, '.key');
  return fs.existsSync(cand) ? cand : null;
}

// ── 动态签发某域名的叶子证书（MITM 用），带缓存 ─────────────────────────────
function signLeaf(domain) {
  ensureDirs();
  const ca = ensureCA();
  const safe = domain.replace(/[^a-z0-9.-]/gi, '_');
  const crt = path.join(LEAF_DIR, safe + '.crt');
  const key = path.join(LEAF_DIR, safe + '.key');
  if (fs.existsSync(crt) && fs.existsSync(key)) {
    return { cert: fs.readFileSync(crt), key: fs.readFileSync(key) };
  }
  if (!ca.key) throw new Error('CA 私钥不可用，无法签发叶子（file:// CA 需提供同名 .key）');
  const csr = path.join(LEAF_DIR, safe + '.csr');
  const ext = path.join(LEAF_DIR, safe + '.ext');
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=' + domain]);
  fs.writeFileSync(ext,
    `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${domain}\n`);
  openssl(['x509', '-req', '-in', csr, '-CA', ca.crt, '-CAkey', ca.key,
    '-CAcreateserial', '-out', crt, '-days', '825', '-extfile', ext]);
  return { cert: fs.readFileSync(crt), key: fs.readFileSync(key) };
}

// ── 还原：删除自动生成的 CA + 叶子缓存（file:// 模式不删用户文件）──
function cleanup() {
  try {
    const meta = fs.existsSync(CA_META) ? JSON.parse(fs.readFileSync(CA_META, 'utf8')) : null;
    if (meta && meta.mode === 'file') return; // 用户的 CA 不动
  } catch {}
  try { fs.rmSync(CA_DIR, { recursive: true, force: true }); } catch {}
}

// ── 系统信任库（GUI 应用 MITM 需要）───────────────────────────────────────────
// Windows: 装进当前用户的「受信任的根证书颁发机构」(Cert:\CurrentUser\Root)，
// 无需管理员；Chromium/Electron 走此库验证。证书指纹存 meta 便于检测/卸载。
function _caThumbprint() {
  // 用 PowerShell 读 CA 证书指纹（与系统库里的 Thumbprint 一致）
  const ps = `$c=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${CA_CRT.replace(/\\/g, '\\\\')}'); $c.Thumbprint`;
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return null; }
}

function isInstalledInSystem() {
  if (process.platform !== 'win32') return false;
  if (!fs.existsSync(CA_CRT)) return false;
  const tp = _caThumbprint();
  if (!tp) return false;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `if (Test-Path 'Cert:\\CurrentUser\\Root\\${tp}') { 'yes' } else { 'no' }`],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out === 'yes';
  } catch { return false; }
}

function installToSystem() {
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
  const ca = ensureCA();   // 确保 CA 已生成（约束 = mitmDomains 并集）
  try {
    // Import-Certificate 到当前用户 Root 库（首次可能弹一次 Windows 安全确认）
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Import-Certificate -FilePath '${ca.crt.replace(/'/g, "''")}' -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null`],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true, thumbprint: _caThumbprint() };
  } catch (e) {
    return { ok: false, error: (e.stderr ? e.stderr.toString() : e.message).slice(0, 300) };
  }
}

function uninstallFromSystem() {
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
  const tp = _caThumbprint();
  if (!tp) return { ok: true };  // 没证书可删
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Remove-Item -Path 'Cert:\\CurrentUser\\Root\\${tp}' -Force -ErrorAction SilentlyContinue`],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  ensureCA, signLeaf, cleanup,
  installToSystem, isInstalledInSystem, uninstallFromSystem,
  paths: { CA_DIR, CA_CRT, CA_KEY },
};
