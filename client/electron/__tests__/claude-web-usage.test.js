'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { decryptChromiumCookie } = require('../usage/claude-web');
const { mapWebUsage, mapUsage } = require('../usage/claude');

function encryptV10(plaintext, password) {
  // 模拟 Chromium：32 字节前缀 + 明文，再 AES-128-CBC
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const body = Buffer.concat([crypto.randomBytes(32), Buffer.from(plaintext, 'utf8')]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), enc]);
}

describe('decryptChromiumCookie', () => {
  it('解开带 32 字节前缀的 sessionKey', () => {
    const pw = 'test-password-value!!';
    const token = 'sk-ant-sid02-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP';
    const enc = encryptV10(token, pw);
    assert.equal(decryptChromiumCookie(enc, pw), token);
  });
});

describe('mapWebUsage', () => {
  it('映射 five_hour / seven_day 并带上套餐', () => {
    const snap = mapWebUsage({
      usage: {
        five_hour: { utilization: 12.5, resets_at: '2026-08-10T12:00:00Z' },
        seven_day: { utilization: 40, resets_at: '2026-08-15T00:00:00Z' },
      },
      organization: {
        uuid: 'org-1',
        capabilities: ['chat', 'claude_pro'],
        rate_limit_tier: 'default_claude_ai',
      },
      account: { email: 'a@b.com' },
    }, { id: 'claude' });
    assert.equal(snap.source, 'web');
    assert.equal(snap.plan, 'Pro');
    assert.equal(snap.windows[0].id, 'five_hour');
    assert.equal(snap.windows[0].usedPercent, 12.5);
    assert.equal(snap.primary.id, 'five_hour');
  });

  it('映射本地 plan-usage-history 采样', () => {
    const snap = mapWebUsage({
      usage: {
        five_hour: { utilization: 14 },
        seven_day: { utilization: 17 },
      },
      organization: { uuid: 'org-1' },
      source: 'local-history',
      sampledAt: '2026-08-10T10:00:00.000Z',
    }, { id: 'claude' });
    assert.equal(snap.source, 'local-history');
    assert.equal(snap.windows.length, 2);
    assert.equal(snap.windows[0].usedPercent, 14);
    assert.equal(snap.windows[1].usedPercent, 17);
    assert.equal(snap.fetchedAt, '2026-08-10T10:00:00.000Z');
  });
});

describe('readClaudePlanUsageHistory', () => {
  const { readClaudePlanUsageHistory } = require('../usage/claude-web');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  it('读取 fh/sd 采样', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-claude-hist-'));
    const histPath = path.join(dir, 'plan-usage-history.json');
    fs.writeFileSync(histPath, JSON.stringify({
      version: 2,
      samples: [
        { t: 1, org: 'o1', u: { fh: 1, sd: 2 } },
        { t: 1786359991572, org: 'o2', u: { fh: 8, sd: 22 } },
      ],
    }));
    const raw = readClaudePlanUsageHistory({ historyPath: histPath });
    assert.equal(raw.source, 'local-history');
    assert.equal(raw.usage.five_hour.utilization, 8);
    assert.equal(raw.usage.seven_day.utilization, 22);
    assert.equal(raw.organization.uuid, 'o2');
  });
});
