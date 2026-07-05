// client/electron/mcp-catalog.js
// MCP 工具市场目录：从 config/mcp-catalog.yaml 加载（与 server/static/defaults 同步）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

/** UI 分组标题（yaml 未加载时的兜底） */
const MCP_CATEGORY_GROUPS = {
  tokenbank: 'Token Bank 内置',
  official: '官方参考（维护中）',
  filesystem: '文件与代码',
  web: '网络与搜索',
  database: '数据库',
  browser: '浏览器自动化',
  collaboration: '协作与 SaaS',
  reasoning: '推理增强',
};

const GROUP_ORDER = [
  'tokenbank', 'official', 'filesystem', 'web', 'database', 'browser', 'collaboration', 'reasoning',
];

/** yaml 候选路径（开发 / 打包） */
const CATALOG_CANDIDATES = [
  path.join(__dirname, 'config', 'mcp-catalog.yaml'),
  path.join(__dirname, '..', '..', 'server', 'static', 'defaults', 'mcp-catalog.yaml'),
];

/** @type {import('./mcp-catalog').CatalogItem[]|null} */
let _cachedCatalog = null;
/** @type {Record<string,string>|null} */
let _cachedCategoryGroups = null;
/** @type {string[]|null} */
let _cachedGroupOrder = null;

function expandHome(val) {
  if (val == null) return val;
  return String(val).replace(/^~(?=\/|$)/, os.homedir());
}

/** snake_case yaml 字段 → 运行时 CatalogItem */
function normalizeYamlItem(raw) {
  if (!raw) return null;
  const catalogId = raw.catalog_id || raw.catalogId;
  if (!catalogId) return null;

  const configFields = (raw.config_fields || raw.configFields || []).map(f => ({
    key: f.key,
    label: f.label,
    type: f.type,
    placeholder: f.placeholder,
    defaultValue: expandHome(f.default_value ?? f.defaultValue ?? ''),
    envKey: f.env_key ?? f.envKey,
    appendArg: f.append_arg ?? f.appendArg,
    required: !!f.required,
  }));

  return {
    catalogId,
    id: raw.id || `mcp-${catalogId}`,
    name: raw.name || catalogId,
    display_name: raw.display_name || raw.displayName || catalogId,
    description: raw.description || '',
    type: raw.type || 'stdio',
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args : [],
    env: raw.env && typeof raw.env === 'object' ? raw.env : {},
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    configFields,
    alwaysInstalled: !!(raw.always_installed ?? raw.alwaysInstalled),
  };
}

function readCatalogDoc() {
  for (const p of CATALOG_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const doc = yaml.load(fs.readFileSync(p, 'utf8'));
      if (doc && Array.isArray(doc.items)) return doc;
    } catch (e) {
      console.warn('[mcp-catalog] load failed:', p, e.message);
    }
  }
  return null;
}

/** 内置 Bridge（yaml 缺失时的最小兜底） */
function fallbackCatalog() {
  return [{
    catalogId: 'tokenbank-agent-bridge',
    id: 'tokenbank-agent-bridge',
    name: 'tokenbank-agent-bridge',
    display_name: 'Token Bank Agent Bridge',
    description: '内置 Agent 派发桥：tb_list_agents / tb_dispatch_agent',
    type: 'stdio',
    command: '__DYNAMIC_ELECTRON__',
    args: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    metadata: {
      category: 'agent',
      categoryGroup: 'tokenbank',
      icon: '🔗',
      tools: ['tb_list_agents', 'tb_dispatch_agent'],
      tags: ['内置', '编排'],
    },
    configFields: [],
    alwaysInstalled: true,
  }];
}

function loadCatalogMeta() {
  if (_cachedCatalog) {
    return {
      items: _cachedCatalog,
      categoryGroups: _cachedCategoryGroups || MCP_CATEGORY_GROUPS,
      groupOrder: _cachedGroupOrder || GROUP_ORDER,
    };
  }

  const doc = readCatalogDoc();
  if (!doc) {
    _cachedCatalog = fallbackCatalog();
    _cachedCategoryGroups = MCP_CATEGORY_GROUPS;
    _cachedGroupOrder = GROUP_ORDER;
    return { items: _cachedCatalog, categoryGroups: _cachedCategoryGroups, groupOrder: _cachedGroupOrder };
  }

  _cachedCatalog = doc.items.map(normalizeYamlItem).filter(Boolean);
  _cachedCategoryGroups = { ...MCP_CATEGORY_GROUPS, ...(doc.category_groups || doc.categoryGroups || {}) };
  _cachedGroupOrder = Array.isArray(doc.group_order || doc.groupOrder)
    ? (doc.group_order || doc.groupOrder)
    : GROUP_ORDER;

  return {
    items: _cachedCatalog,
    categoryGroups: _cachedCategoryGroups,
    groupOrder: _cachedGroupOrder,
  };
}

/** 测试或热重载时清空缓存 */
function resetCatalogCache() {
  _cachedCatalog = null;
  _cachedCategoryGroups = null;
  _cachedGroupOrder = null;
}

function getCatalogItem(catalogId) {
  const { items } = loadCatalogMeta();
  return items.find(c => c.catalogId === catalogId) || null;
}

function listCatalogItems() {
  return loadCatalogMeta().items.map(item => ({ ...item }));
}

/** 按分组整理目录（供 UI 展示） */
function listCatalogGrouped() {
  const { items, categoryGroups, groupOrder } = loadCatalogMeta();
  const groups = {};
  for (const g of groupOrder) groups[g] = [];

  for (const item of items) {
    const key = item.metadata?.categoryGroup || item.metadata?.category || 'official';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  return groupOrder
    .filter(g => groups[g]?.length)
    .map(g => ({ id: g, label: categoryGroups[g] || MCP_CATEGORY_GROUPS[g] || g, items: groups[g] }));
}

module.exports = {
  MCP_CATEGORY_GROUPS,
  GROUP_ORDER,
  getCatalogItem,
  listCatalogItems,
  listCatalogGrouped,
  resetCatalogCache,
  normalizeYamlItem,
  loadCatalogMeta,
};
