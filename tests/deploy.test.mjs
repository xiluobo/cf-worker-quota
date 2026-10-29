import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, buildBootstrapConfig, DEPLOY_ENTRY } from '../scripts/prepare-deploy.mjs';

test('deployment entry is the tested quota worker', () => {
  assert.equal(DEPLOY_ENTRY, '../worker.js');
});

test('bootstrap config uses the provided D1 database without existing settings', () => {
  const config = buildBootstrapConfig('account', '11111111-1111-1111-1111-111111111111');
  assert.equal(config.main, '../worker.js');
  assert.deepEqual(config.d1_databases, [{ binding: 'D1', database_id: '11111111-1111-1111-1111-111111111111' }]);
  assert.throws(() => buildBootstrapConfig('account', 'not-a-database-id'), /D1_DATABASE_ID/);
});

test('deployment preserves database IDs and never writes credentials into config', () => {
  const settings = { bindings: [
    {type:'d1',name:'D1',id:'original-database'},
    {type:'d1',name:'OTHER_DB',id:'other-database'},
    {type:'secret_text',name:'UUID'},
    {type:'plain_text',name:'COUNTRY',text:'US'}
  ]};
  const config = buildConfig(settings, 'account');
  assert.equal(config.keep_vars,true);
  assert.equal(config.observability.enabled, true);
  assert.equal(buildBootstrapConfig('account', '11111111-1111-1111-1111-111111111111').observability.enabled, true);
  assert.deepEqual(config.d1_databases.map(b=>b.database_id),['original-database','other-database']);
  assert.equal(config.vars,undefined);
  assert.throws(()=>buildConfig({bindings:[]},'account'),/D1/);
  assert.throws(()=>buildConfig({bindings:[settings.bindings[0]]},'account'),/UUID/);
  assert.throws(()=>buildConfig({bindings:[...settings.bindings,{type:'kv_namespace',name:'KV'}]},'account'),/additional/);
});
