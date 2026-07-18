const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSemverVersion,
  compareVersions,
  isRemoteNewer,
  pickLatestReleaseTag,
  feedUrlForTag,
} = require('../updater-release');

function rel(tag, { prerelease = false, assets = ['latest-mac.yml', 'latest.yml'] } = {}) {
  return {
    tag_name: tag,
    prerelease,
    draft: false,
    assets: assets.map((name) => ({ name })),
  };
}

describe('updater-release', () => {
  it('normalizes legacy beta version strings', () => {
    assert.equal(normalizeSemverVersion('0.4.9-beta3'), '0.4.9-beta.3');
    assert.equal(normalizeSemverVersion('v0.4.9-beta4'), '0.4.9-beta.4');
  });

  it('compares beta3 < beta4 < beta5', () => {
    assert.ok(compareVersions('0.4.9-beta4', '0.4.9-beta3') > 0);
    assert.ok(compareVersions('0.4.9-beta5', '0.4.9-beta4') > 0);
    assert.ok(isRemoteNewer('0.4.9-beta3', 'v0.4.9-beta4'));
  });

  it('stable 0.5.0 is newer than 0.4.9-beta.17', () => {
    assert.ok(isRemoteNewer('0.4.9-beta.17', 'v0.5.0'));
  });

  it('allowPrerelease includes stable so beta users can upgrade to 0.5.0', () => {
    const releases = [
      rel('v0.5.0', { prerelease: false }),
      rel('v0.4.9-beta.17', { prerelease: true }),
      rel('v0.4.9', { prerelease: false }),
    ];
    assert.equal(pickLatestReleaseTag(releases, true, 'darwin'), 'v0.5.0');
    assert.equal(pickLatestReleaseTag(releases, false, 'darwin'), 'v0.5.0');
  });

  it('allowPrerelease=false skips newer prerelease on higher series', () => {
    const releases = [
      rel('v0.5.0-beta.1', { prerelease: true }),
      rel('v0.4.9', { prerelease: false }),
    ];
    assert.equal(pickLatestReleaseTag(releases, false, 'darwin'), 'v0.4.9');
    assert.equal(pickLatestReleaseTag(releases, true, 'darwin'), 'v0.5.0-beta.1');
  });

  it('builds generic feed url for tag', () => {
    assert.equal(
      feedUrlForTag('v0.4.9-beta4'),
      'https://github.com/wink-run/local-llm-proxy/releases/download/v0.4.9-beta4/',
    );
  });
});
