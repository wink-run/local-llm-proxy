/**
 * GitHub Release 更新解析。
 *
 * 项目历史版本号形如 0.4.9-beta4（无点号），semver 会把 prerelease 解析成
 * 「beta4」而非标准「beta + 4」，导致 electron-updater 的 GitHubProvider
 * 把每个 betaN 当成独立 channel，无法从 beta3 升到 beta4。
 * 此处统一规范化后再比较，并可直接指向具体 release 的 yml。
 */

const https = require('https');
const semver = require('semver');

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

function parseVersion(version) {
  const norm = normalizeSemverVersion(version);
  return semver.valid(norm) ? semver.parse(norm) : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return semver.compare(pa, pb);
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
  let bestParsed = null;

  for (const rel of releases) {
    if (rel.draft) continue;
    const tag = String(rel.tag_name || '');
    const parsed = parseVersion(tag);
    if (!parsed) continue;

    if (allowPrerelease) {
      if (!rel.prerelease) continue;
    } else if (rel.prerelease) {
      continue;
    }

    if (!bestParsed || semver.gt(parsed, bestParsed)) {
      bestTag = tag;
      bestParsed = parsed;
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
