'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  expandEntity,
  resolveHandlerId,
  normalizeHandlerId,
  normalizeEntityId,
  TRAE_WORK_HANDLER,
  TRAE_WORK_ENTITY,
} = require('../app-handlers');

test('trae-work handler expands session import with manual route bind', () => {
  const ent = expandEntity({ id: TRAE_WORK_ENTITY, handler: TRAE_WORK_HANDLER });
  assert.equal(ent.gateway_proxy, false);
  assert.equal(ent.session_import, true);
  assert.equal(ent.session_trace, true);
  assert.equal(ent.route_bindable, true);
  assert.equal(ent.trace_profile, 'trae-work-trace');
  assert.equal(ent.session_source_id, 'trae-work');
  assert.equal(ent.config_file, undefined);
});

test('legacy trae ids map to trae-work-stats', () => {
  assert.equal(normalizeHandlerId('trae-stats'), TRAE_WORK_HANDLER);
  assert.equal(normalizeEntityId('trae'), TRAE_WORK_ENTITY);
  assert.equal(resolveHandlerId({ preset_id: 'trae' }), TRAE_WORK_HANDLER);
  assert.equal(resolveHandlerId({ preset_id: 'Trae' }), TRAE_WORK_HANDLER);
  assert.equal(resolveHandlerId({ handler: 'trae-stats' }), TRAE_WORK_HANDLER);
});
