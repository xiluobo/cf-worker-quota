import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../scripts/prepare-deploy.mjs';

test('deployment preserves database IDs and never writes credentials into config', () => {
  const settings = { bindings: [
    {type:'d1',name:'D1',id:'original-database'},
    {type:'d1',name:'OTHER_DB',id:'other-database'},
    {type:'secret_text',name:'UUID'},
    {type:'plain_text',name:'COUNTRY',text:'US'}
  ]};
  const config = buildConfig(settings, 'account');
  assert.equal(config.keep_vars,true);
  assert.deepEqual(config.d1_databases.map(b=>b.database_id),['original-database','other-database']);
  assert.equal(config.vars,undefined);
  assert.throws(()=>buildConfig({bindings:[]},'account'),/D1/);
  assert.throws(()=>buildConfig({bindings:[settings.bindings[0]]},'account'),/UUID/);
  assert.throws(()=>buildConfig({bindings:[...settings.bindings,{type:'kv_namespace',name:'KV'}]},'account'),/additional/);
});
