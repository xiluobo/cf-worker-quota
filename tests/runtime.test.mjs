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
    const missingTable = await mf.dispatchFetch('https://worker.example/' + UUID);
    assert.equal(missingTable.status, 503);
    assert.match(await missingTable.text(), /schema\.sql/);
    const qr = await mf.dispatchFetch('https://worker.example/' + UUID + '/qr/n1');
    assert.equal(qr.status, 200, 'qr does not need D1');
    assert.match(qr.headers.get('content-type') || '', /image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg /);
    assert.equal((await mf.dispatchFetch('https://worker.example/' + UUID + '/qr/usage')).status, 404);
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
    const head = await mf.dispatchFetch('https://worker.example/' + UUID + '/usage', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await mf.dispatchFetch('https://worker.example/' + UUID, { method: 'POST' })).status, 405);
    const wsResponse = await mf.dispatchFetch('https://worker.example/', {headers:{Upgrade:'websocket'}});
    assert.equal(wsResponse.status,101);
    const ws = wsResponse.webSocket;
    ws.accept();
    const closed = new Promise(resolve=>ws.addEventListener('close',resolve,{once:true}));
    // Invalid VLESS UUID must be parsed (not rejected as a Blob/text frame) and closed.
    ws.send(new Uint8Array(24));
    const event = await closed;
    assert.equal(event.code, 1008);
  } finally { await mf.dispose(); }
});
