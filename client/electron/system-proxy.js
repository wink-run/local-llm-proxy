// client/electron/system-proxy.js
// 系统代理设置（GUI 应用 MITM 托管用）。Windows: 改 WinINET 注册表，
// 托管前备份原值，取消托管/退出时还原。仅当前用户，无需管理员。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

const TB_DIR  = path.join(os.homedir(), '.tokenbank');
const BACKUP  = path.join(TB_DIR, 'system-proxy.backup.json');
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function ps(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function readCurrent() {
  const out = ps(
    `$k='${REG_KEY.replace(/\\/g, '\\\\')}';` +
    `$p=Get-ItemProperty -Path "Registry::$k";` +
    `[pscustomobject]@{ enable=[int]($p.ProxyEnable); server=[string]($p.ProxyServer); override=[string]($p.ProxyOverride) } | ConvertTo-Json -Compress`
  );
  try { return JSON.parse(out.trim()); } catch { return { enable: 0, server: '', override: '' }; }
}

// 设系统代理为 host:port（保存原值，仅首次保存，避免覆盖备份）
function enable(hostPort) {
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
  try {
    if (!fs.existsSync(TB_DIR)) fs.mkdirSync(TB_DIR, { recursive: true });
    if (!fs.existsSync(BACKUP)) {
      fs.writeFileSync(BACKUP, JSON.stringify(readCurrent()), 'utf8');
    }
    const k = REG_KEY.replace(/\\/g, '\\\\');
    ps(
      `$k="Registry::${k}";` +
      `Set-ItemProperty -Path $k -Name ProxyServer  -Value '${hostPort}';` +
      `Set-ItemProperty -Path $k -Name ProxyEnable  -Value 1;` +
      `Set-ItemProperty -Path $k -Name ProxyOverride -Value '<-loopback>';`
    );
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 还原系统代理为备份值（若有），并删备份
function restore() {
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
  try {
    let bak = { enable: 0, server: '', override: '' };
    if (fs.existsSync(BACKUP)) {
      try { bak = JSON.parse(fs.readFileSync(BACKUP, 'utf8')); } catch {}
    }
    const k = REG_KEY.replace(/\\/g, '\\\\');
    ps(
      `$k="Registry::${k}";` +
      `Set-ItemProperty -Path $k -Name ProxyEnable -Value ${bak.enable ? 1 : 0};` +
      `Set-ItemProperty -Path $k -Name ProxyServer -Value '${(bak.server || '').replace(/'/g, "''")}';` +
      (bak.override
        ? `Set-ItemProperty -Path $k -Name ProxyOverride -Value '${bak.override.replace(/'/g, "''")}';`
        : `Remove-ItemProperty -Path $k -Name ProxyOverride -ErrorAction SilentlyContinue;`)
    );
    if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 当前系统代理是否指向我们（host:port）
function isEnabledTo(hostPort) {
  if (process.platform !== 'win32') return false;
  try {
    const cur = readCurrent();
    return !!cur.enable && cur.server === hostPort;
  } catch { return false; }
}

module.exports = { enable, restore, isEnabledTo, readCurrent };
