// 本机唯一设备 ID：持久化在 ~/.tokenbank/device-id，安装后首次启动自动生成
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEVICE_ID_FILE = path.join(os.homedir(), '.tokenbank', 'device-id');
const ID_RE = /^dev-[a-f0-9]{16}$/;

function ensureTokenbankDir() {
  const dir = path.dirname(DEVICE_ID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 读取已持久化的设备 ID（不存在或无效时返回 null） */
function readDeviceId() {
  try {
    const id = fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
    if (id && ID_RE.test(id)) return id;
  } catch (_) {}
  return null;
}

/** 写入设备 ID（原子写） */
function writeDeviceId(id) {
  if (!id || !ID_RE.test(id)) return;
  ensureTokenbankDir();
  const tmp = `${DEVICE_ID_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${id}\n`, 'utf8');
  fs.renameSync(tmp, DEVICE_ID_FILE);
}

/** 从旧版 config.json 迁移 device_id */
function readLegacyDeviceId() {
  try {
    const { readAgentConfig } = require('./config-loader');
    const legacy = String(readAgentConfig()?.device_id || '').trim();
    if (legacy && ID_RE.test(legacy)) return legacy;
  } catch (_) {}
  return null;
}

/**
 * 确保本机有唯一设备 ID：优先 ~/.tokenbank/device-id，否则迁移旧配置或新生成。
 */
function ensureDeviceId() {
  let id = readDeviceId();
  if (!id) id = readLegacyDeviceId();
  if (!id) id = `dev-${crypto.randomBytes(8).toString('hex')}`;
  writeDeviceId(id);
  return id;
}

module.exports = {
  DEVICE_ID_FILE,
  readDeviceId,
  writeDeviceId,
  ensureDeviceId,
};
