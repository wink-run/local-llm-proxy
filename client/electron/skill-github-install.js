// client/electron/skill-github-install.js
// 从 GitHub URL / owner/repo 解析并落盘 Skill（skillhub 不支持此类来源）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');
const https = require('https');
const http = require('http');

/** UI / 安装对话框约定的默认落盘根 */
const TOKENBANK_SKILL_ROOT = path.join(os.homedir(), '.tokenbank', 'skills');

// repo 用贪婪匹配；末尾 .git 在解析时剥掉（避免 +? 只吃到 1 个字符）
const GITHUB_URL_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(?:tree|blob)\/([^/\s#]+)(?:\/([^\s#]+))?)?/i;
const OWNER_REPO_RE = /(?:^|[\s`'"(【])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:[\s`'"),。；;】]|$)/;

/**
 * 从用户输入提取 GitHub Skill 来源（URL 或 owner/repo）。
 * 支持：纯 URL、`安装skill https://…`、`npx skills add https://…`、`owner/repo`。
 * @returns {{ owner: string, repo: string, ref: string, subpath: string, cloneUrl: string, sourceUrl: string } | null}
 */
function parseGithubSkillRef(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  const urlMatch = text.match(GITHUB_URL_RE);
  if (urlMatch) {
    const owner = urlMatch[1];
    const repo = String(urlMatch[2] || '').replace(/\.git$/i, '');
    if (!owner || !repo || !isLikelyGithubRepoName(repo)) return null;
    const ref = urlMatch[3] || '';
    const subpath = String(urlMatch[4] || '').replace(/\/+$/, '');
    return {
      owner,
      repo,
      ref,
      subpath,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      sourceUrl: `https://github.com/${owner}/${repo}${ref ? `/tree/${ref}${subpath ? `/${subpath}` : ''}` : ''}`,
    };
  }

  // 无 github.com 时，仅接受明显的 owner/repo（避免把 skillhub slug 当仓库）
  if (/github\.com/i.test(text)) return null;
  const short = text.match(OWNER_REPO_RE);
  if (!short) return null;
  const [owner, repoRaw] = short[1].split('/');
  const repo = String(repoRaw || '').replace(/\.git$/i, '');
  if (!owner || !repo || !isLikelyGithubRepoName(repo)) return null;
  // 单段 slug（无 slash）已由 OWNER_REPO_RE 排除；再排除 skillhub 常见短名误触
  if (!/[A-Za-z]/.test(owner) || !/[A-Za-z]/.test(repo)) return null;
  return {
    owner,
    repo,
    ref: '',
    subpath: '',
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    sourceUrl: `https://github.com/${owner}/${repo}`,
  };
}

function isLikelyGithubRepoName(name) {
  const n = String(name || '');
  return /^[A-Za-z0-9_.-]+$/.test(n) && n.length >= 1 && n.length <= 100;
}

function skillMdIn(dir) {
  return ['SKILL.md', 'skill.md'].map((f) => path.join(dir, f)).find((p) => fs.existsSync(p));
}

function findSkillDir(root, preferredSubpath = '') {
  if (preferredSubpath) {
    const sub = path.join(root, ...preferredSubpath.split('/').filter(Boolean));
    if (skillMdIn(sub)) return sub;
  }
  if (skillMdIn(root)) return root;
  // 单层子目录兜底（monorepo 只有一个 skill）
  try {
    const kids = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    const hits = kids.map((d) => path.join(root, d.name)).filter((p) => skillMdIn(p));
    if (hits.length === 1) return hits[0];
  } catch { /* ignore */ }
  return null;
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: opts.timeout || 180000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: process.env,
      ...opts,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        reject(new Error(detail || `${cmd} failed`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function downloadToFile(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, {
      timeout: 120000,
      headers: {
        'User-Agent': 'TokenBank-SkillInstall',
        Accept: 'application/octet-stream',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`下载重定向过多: ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        downloadToFile(next, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
        return;
      }
      pipeline(res, createWriteStream(dest)).then(resolve, reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`下载超时: ${url}`));
    });
  });
}

async function cloneGithubRepo(ref, destDir) {
  const args = ['clone', '--depth', '1'];
  if (ref.ref) args.push('--branch', ref.ref);
  args.push(ref.cloneUrl, destDir);
  await execFileAsync('git', args, { timeout: 180000 });
}

async function downloadGithubZip(ref, extractParent) {
  const AdmZip = require('adm-zip');
  const candidates = [];
  if (ref.ref) {
    candidates.push(`https://codeload.github.com/${ref.owner}/${ref.repo}/zip/refs/heads/${ref.ref}`);
    candidates.push(`https://codeload.github.com/${ref.owner}/${ref.repo}/zip/refs/tags/${ref.ref}`);
    candidates.push(`https://codeload.github.com/${ref.owner}/${ref.repo}/zip/${ref.ref}`);
  } else {
    candidates.push(`https://codeload.github.com/${ref.owner}/${ref.repo}/zip/refs/heads/main`);
    candidates.push(`https://codeload.github.com/${ref.owner}/${ref.repo}/zip/refs/heads/master`);
  }

  const zipPath = path.join(extractParent, `${ref.repo}-${Date.now()}.zip`);
  let lastErr = null;
  for (const url of candidates) {
    try {
      await downloadToFile(url, zipPath);
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractParent, true);
      const entries = fs.readdirSync(extractParent, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith(`${ref.repo}-`));
      if (!entries.length) throw new Error('zip 解压后未找到仓库目录');
      return path.join(extractParent, entries[0].name);
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    }
  }
  throw lastErr || new Error('无法从 GitHub 下载 zip');
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * 将 GitHub Skill 落到 installRoot/<skillName>，返回技能目录绝对路径。
 * @param {string|object} source 用户输入或 parseGithubSkillRef 结果
 * @param {{ force?: boolean, installRoot?: string }} [opts]
 */
async function materializeGithubSkill(source, opts = {}) {
  const ref = typeof source === 'string' ? parseGithubSkillRef(source) : source;
  if (!ref || !ref.owner || !ref.repo) {
    throw new Error('无法识别 GitHub Skill 地址（需要 https://github.com/owner/repo）');
  }

  const installRoot = opts.installRoot || TOKENBANK_SKILL_ROOT;
  fs.mkdirSync(installRoot, { recursive: true });

  const skillName = ref.subpath
    ? path.basename(ref.subpath)
    : ref.repo;
  const targetDir = path.join(installRoot, skillName);

  if (fs.existsSync(targetDir)) {
    if (!opts.force && skillMdIn(targetDir)) {
      return { skillDir: targetDir, skillName, alreadyInstalled: true, ref };
    }
    if (!opts.force) {
      throw new Error(`目标目录已存在: ${targetDir}（可 force 覆盖）`);
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-gh-skill-'));
  let stagingRoot = path.join(tmpParent, 'repo');
  try {
    try {
      await cloneGithubRepo(ref, stagingRoot);
    } catch (cloneErr) {
      // git 不可用或网络失败时回退 zip
      stagingRoot = await downloadGithubZip(ref, tmpParent);
    }

    const skillSrc = findSkillDir(stagingRoot, ref.subpath);
    if (!skillSrc) {
      throw new Error(`仓库中未找到 SKILL.md（${ref.sourceUrl}）`);
    }

    copyDirRecursive(skillSrc, targetDir);
    if (!skillMdIn(targetDir)) {
      throw new Error(`安装后未找到 ${skillName}/SKILL.md`);
    }
    return { skillDir: targetDir, skillName, alreadyInstalled: false, ref };
  } finally {
    try { fs.rmSync(tmpParent, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  TOKENBANK_SKILL_ROOT,
  parseGithubSkillRef,
  materializeGithubSkill,
  skillMdIn,
  findSkillDir,
};
