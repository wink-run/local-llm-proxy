// 主进程侧：把会话扫盘派到 worker_threads，Promise 等待期间主线程仍可画 UI / 处理 IPC。
'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_FILE = path.join(__dirname, 'session-offthread-worker.js');

let _seq = 0;
const _pending = new Map(); // id -> { resolve, reject }
const _workers = { list: null, telemetry: null };

function spawn(kind) {
  const w = new Worker(WORKER_FILE);
  w.on('message', (msg) => {
    if (!msg || msg.id == null) return;
    const p = _pending.get(msg.id);
    if (!p) return;
    _pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  w.on('error', (err) => {
    console.error(`[session-offthread] ${kind} worker:`, err && err.message);
    failAll(kind, err);
  });
  w.on('exit', (code) => {
    if (_workers[kind] === w) _workers[kind] = null;
    if (code !== 0) failAll(kind, new Error(`worker_exit_${code}`));
  });
  return w;
}

function failAll(kind, err) {
  for (const [id, p] of _pending) {
    if (p.kind !== kind) continue;
    _pending.delete(id);
    p.reject(err);
  }
}

function worker(kind) {
  if (!_workers[kind]) _workers[kind] = spawn(kind);
  return _workers[kind];
}

function call(kind, type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++_seq;
    _pending.set(id, { resolve, reject, kind });
    try {
      worker(kind).postMessage({ id, type, payload: payload || {} });
    } catch (e) {
      _pending.delete(id);
      reject(e);
    }
  });
}

function listAllSessions(opts = {}) {
  return call('list', 'listAll', opts);
}

function runTelemetry(opts = {}) {
  return call('telemetry', 'telemetry', opts);
}

function terminate() {
  for (const kind of Object.keys(_workers)) {
    try { _workers[kind]?.terminate(); } catch { /* ignore */ }
    _workers[kind] = null;
  }
  for (const p of _pending.values()) {
    p.reject(new Error('terminated'));
  }
  _pending.clear();
}

module.exports = { listAllSessions, runTelemetry, terminate };
