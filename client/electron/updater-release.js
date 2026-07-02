/**
 * GitHub Release 更新解析。
 *
 * 项目历史版本号形如 0.4.9-beta4（无点号），electron-updater 会把每个 betaN
 * 当成独立 channel。此处统一规范化后再比较，并可直接指向具体 release 的 yml。
 *
 * 注意：不依赖 npm semver 包，避免打包后 asar 内找不到模块。
 */

const https = require('https');

const GH_OWNER = 'wink-run';
const GH_REPO = 'local-llm-proxy';

/** 0.4.9-beta4 → 0.4.9-beta.4 */
function normalizeSemverVersion(version) {
  const s = String(version || '').trim().replace(/^v/i, '');
  return s
    .replace(/-beta(\d+)\b/i, '-beta.$1')
    .replace(/-alpha(\d+)\b/i, '-alpha.$1')
    .replace(/-rc(\d+)\b/i, '-rc.$1');
}

/** 解析为 { major, minor, patch, prerelease: string[] | null } */
function parseVersionParts(version) {
  const norm = normalizeSemverVersion(version);
  const m = norm.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : null,
  };
}

function comparePrerelease(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai) ? Number(ai) : null;
    const bn = /^\d+$/.test(bi) ? Number(bi) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an - bn;
      continue;
    }
    if (an !== null) return -1;
    if (bn !== null) return 1;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.prerelease && !pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function isRemoteNewer(currentVersion, remoteTag) {
  return compareVersions(remoteTag, currentVersion) > 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Token-Bank-Updater',
        Accept: 'application/vnd.github+json',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('GitHub API timeout')));
  });
}

/**
 * 查找符合通道策略的最新 release tag（含 v 前缀，如 v0.4.9-beta4）。
 * @param {boolean} allowPrerelease 是否包含预发布
 */
async function findLatestReleaseTag(allowPrerelease) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=50`,
  );

  let bestTag = null;

  for (const rel of releases) {
    if (rel.draft) continue;
    const tag = String(rel.tag_name || '');
    if (!parseVersionParts(tag)) continue;

    if (allowPrerelease) {
      if (!rel.prerelease) continue;
    } else if (rel.prerelease) {
      continue;
    }

    if (!bestTag || compareVersions(tag, bestTag) > 0) {
      bestTag = tag;
    }
  }

  return bestTag;
}

/** 指向指定 tag 目录下的 latest-mac.yml / latest.yml（GenericProvider） */
function feedUrlForTag(tag) {
  const t = String(tag || '').startsWith('v') ? tag : `v${tag}`;
  return `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${t}/`;
}

module.exports = {
  normalizeSemverVersion,
  compareVersions,
  isRemoteNewer,
  findLatestReleaseTag,
  feedUrlForTag,
};
