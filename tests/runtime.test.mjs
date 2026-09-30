import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const UUID = '11111111-1111-4111-8111-111111111111';
const original = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
// Test-only wrapper exercises actual workerd + D1 SQL; not included in deployed source.
const script = original.replace('export default {', 'const app = {') + `
export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/__test/charge') {
    try { await charge(env.D1, { ...readConfig(env), total: 100 }, 10); return new Response('ok'); }
    catch { return new Response('quota', {status:403}); }
  }
  return app.fetch(request, env, ctx);
}};`;

test('real workerd serves all subscriptions and D1 prevents concurrent overrun', { timeout: 60000 }, async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, modules: true, script, compatibilityDate: '2026-09-30',
    bindings: { UUID, TOTAL_TRAFFIC: '1', EXPIRE_DATE: '2099-12-31', COUNTRY: 'JP' },
    d1Databases: ['D1'] }));
  try {
    const db = await mf.getD1Database('D1');
    await db.prepare('CREATE TABLE traffic (uuid TEXT PRIMARY KEY, used_bytes INTEGER DEFAULT 0, updated_at INTEGER)').run();
    for (const path of ['', '/ty', '/pty', '/cl', '/pcl', '/sb', '/psb', '/usage']) {
      const res = await mf.dispatchFetch('https://worker.example/' + UUID + path);
      assert.equal(res.status, 200, path);
      const text = await res.text();
      if (path.endsWith('ty')) assert.match(Buffer.from(text,'base64').toString(), /vless:\/\//);
    }
    const results = await Promise.all(Array.from({length:20},()=>mf.dispatchFetch('https://worker.example/__test/charge')));
    assert.equal(results.filter(r=>r.status===200).length,10);
    const row = await db.prepare('SELECT used_bytes FROM traffic WHERE uuid=?').bind(UUID).first();
    assert.equal(row.used_bytes,100);
    const usage = await (await mf.dispatchFetch('https://worker.example/'+UUID+'/usage')).json();
    assert.equal(usage.used,100);
    const wsResponse = await mf.dispatchFetch('https://worker.example/', {headers:{Upgrade:'websocket'}});
    assert.equal(wsResponse.status,101);
    const ws = wsResponse.webSocket;
    ws.accept();
    const closed = new Promise(resolve=>ws.addEventListener('close',resolve,{once:true}));
    // Invalid VLESS UUID must close the socket without touching a destination.
    ws.send(new Uint8Array(24));
    await closed;
  } finally { await mf.dispose(); }
});
