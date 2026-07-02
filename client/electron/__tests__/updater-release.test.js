const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSemverVersion,
  compareVersions,
  isRemoteNewer,
  feedUrlForTag,
} = require('../updater-release');

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

  it('builds generic feed url for tag', () => {
    assert.equal(
      feedUrlForTag('v0.4.9-beta4'),
      'https://github.com/wink-run/local-llm-proxy/releases/download/v0.4.9-beta4/',
    );
  });
});
