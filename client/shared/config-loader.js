// client/shared/config-loader.js
// Works in both Electron main process and Node.js CLI — no Electron imports.
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const AGENT_CONFIG_PATH = path.join(os.homedir(), '.llm-agent', 'config.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function _ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function _writeJsonAtomic(filePath, obj) {
  _ensureDir(filePath);
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── Agent config (~/.llm-agent/config.json) ───────────────────────────────────

/** Returns parsed config object or null if file missing/invalid. */
function readAgentConfig() {
  return _readJson(AGENT_CONFIG_PATH);
}

/** Writes config atomically (tmp + rename). */
function writeAgentConfig(cfg) {
  _writeJsonAtomic(AGENT_CONFIG_PATH, cfg);
}

// ── Local config (scene_routes, local_keys, cloud_config) ─────────────────────

const DEFAULT_LOCAL_CONFIG_PATH = path.join(os.homedir(), '.llm-agent', 'local-config.json');

/**
 * Returns local config object { scene_routes, local_keys, cloud_config } or null.
 * @param {string} [localConfigPath] - optional override; defaults to ~/.llm-agent/local-config.json
 */
function readLocalConfig(localConfigPath) {
  return _readJson(localConfigPath || DEFAULT_LOCAL_CONFIG_PATH);
}

/**
 * Writes local config atomically.
 * @param {object} cfg
 * @param {string} [localConfigPath]
 */
function writeLocalConfig(cfg, localConfigPath) {
  _writeJsonAtomic(localConfigPath || DEFAULT_LOCAL_CONFIG_PATH, cfg);
}

// ── File watchers ─────────────────────────────────────────────────────────────

/**
 * Watch both config files for changes.
 * onChange(type) is called with type = 'agent' | 'local'.
 * Debounced 300 ms to avoid double-fires on atomic writes.
 * Returns a function that stops both watchers.
 *
 * @param {string} [localConfigPath]
 * @param {function} onChange
 * @returns {function} stop
 */
function watchConfigs(localConfigPath, onChange) {
  const localPath = localConfigPath || DEFAULT_LOCAL_CONFIG_PATH;

  const timers = {};

  function _debounced(type) {
    if (timers[type]) clearTimeout(timers[type]);
    timers[type] = setTimeout(() => {
      delete timers[type];
      onChange(type);
    }, 300);
  }

  let watcher1 = null;
  let watcher2 = null;

  // Watch agent config — create the file/dir first if needed so fs.watch won't throw
  try {
    _ensureDir(AGENT_CONFIG_PATH);
    watcher1 = fs.watch(AGENT_CONFIG_PATH, () => _debounced('agent'));
  } catch (_) {
    // File may not exist yet; watcher1 stays null
  }

  try {
    _ensureDir(localPath);
    watcher2 = fs.watch(localPath, () => _debounced('local'));
  } catch (_) {
    // File may not exist yet; watcher2 stays null
  }

  return function stop() {
    Object.values(timers).forEach(t => clearTimeout(t));
    if (watcher1) { try { watcher1.close(); } catch (_) {} }
    if (watcher2) { try { watcher2.close(); } catch (_) {} }
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  AGENT_CONFIG_PATH,
  readAgentConfig,
  writeAgentConfig,
  readLocalConfig,
  writeLocalConfig,
  watchConfigs,
};
