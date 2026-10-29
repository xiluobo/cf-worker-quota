import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const moduleSource = source.replace("await import('cloudflare:sockets')", "await Promise.resolve({ connect: () => { throw new Error('no sockets'); } })");
const mod = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
const worker = mod.default;
const UUID = '11111111-1111-4111-8111-111111111111';

class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('CREATE TABLE traffic(uuid TEXT PRIMARY KEY,used_bytes INTEGER DEFAULT 0,updated_at INTEGER)');
  }
  withSession() { return this; }
  prepare(sql) {
    const stmt = this.sqlite.prepare(sql);
    return { bind: (...args) => ({ first: async () => stmt.get(...args) || null }) };
  }
}
function env(extra = {}) { return { UUID, TOTAL_TRAFFIC: '1', EXPIRE_DATE: '2099-12-31', D1: new D1(), ...extra }; }
function context() { return { promises: [], waitUntil(p) { this.promises.push(p); } }; }

test('qrMatrix sizes and finder patterns', () => {
  const short = mod.qrMatrix('hello');
  assert.equal(short.size, 21, 'hello fits version 1');
  // 定位图案：左上 7x7 边框与中心
  assert.equal(short.rows[0].slice(0, 7), '1111111');
  assert.equal(short.rows[1].slice(0, 7), '1000001');
  assert.equal(short.rows[2].slice(0, 7), '1011101');
  assert.equal(short.rows[6].slice(0, 7), '1111111');
  // 暗模块在 (size-8, 8)
  assert.equal(short.rows[short.size - 8][8], '1');
  const sub = mod.qrMatrix('https://cf-worker-quota.8443.workers.dev/' + UUID + '/n1');
  assert.equal(sub.size, 37, 'subscription URL fits version 5');
  assert.notEqual(short.rows.join(), sub.rows.join(), 'different text gives different matrix');
});

test('qrToSVG returns inline SVG', () => {
  const svg = mod.qrToSVG('https://example.com/' + UUID + '/ty');
  assert.ok(svg.startsWith('<svg '), 'starts with svg tag');
  assert.ok(svg.includes('<path d="'), 'contains dark-module path');
  assert.ok(svg.includes('shape-rendering="crispEdges"'), 'crisp edges for scanning');
  assert.ok(!svg.includes('<image') && !svg.includes('href='), 'no external resource in QR svg');
});

test('page links lazy QR images for subscriptions only; QR route serves SVG without D1', async () => {
  const res = await worker.fetch(new Request('https://worker.example/' + UUID), env(), context());
  assert.equal(res.status, 200);
  const html = await res.text();
  // 6 个组合订阅 + 13 个单节点订阅 = 19 个二维码（按需加载，页面本身不再计算二维码）
  const count = (html.match(/<details><summary>二维码<\/summary><img loading="lazy"/g) || []).length;
  assert.equal(count, 19, 'page has 19 QR codes for subscription links');
  assert.match(res.headers.get('Content-Security-Policy'), /img-src 'self'/);
  assert.ok(html.includes('vless://'), 'page still lists node URIs');
  const noDb = env({ D1: null });
  for (const target of ['ty', 'cl', 'sb', 'pty', 'pcl', 'psb', 'n1', 'n13']) {
    const qr = await worker.fetch(new Request('https://worker.example/' + UUID + '/qr/' + target), noDb, context());
    assert.equal(qr.status, 200, target);
    assert.match(qr.headers.get('Content-Type'), /image\/svg\+xml/);
    const svg = await qr.text();
    assert.equal(svg, mod.qrToSVG('https://worker.example/' + UUID + '/' + target));
  }
  for (const bad of ['/qr/x', '/qr/n14', '/qr/usage']) {
    assert.equal((await worker.fetch(new Request('https://worker.example/' + UUID + bad), noDb, context())).status, 404, bad);
  }
  assert.equal((await worker.fetch(new Request('https://worker.example/22222222-2222-4222-8222-222222222222/qr/ty'), noDb, context())).status, 404);
});

test('handler never throws: missing env, broken D1 and missing table give clear errors', async () => {
  const req = () => new Request('https://worker.example/' + UUID);
  assert.equal((await worker.fetch(req(), undefined, context())).status, 503);
  assert.equal((await worker.fetch(req(), {}, context())).status, 503);
  const r1 = await worker.fetch(req(), { UUID, D1: { prepare() { throw new Error('D1_ERROR: no such table: traffic: SQLITE_ERROR'); } } }, context());
  assert.equal(r1.status, 503); assert.match(await r1.text(), /schema\.sql/);
  const r2 = await worker.fetch(req(), { UUID, D1: 'not-a-binding' }, context());
  assert.equal(r2.status, 503); assert.match(await r2.text(), /D1/);
  const r3 = await worker.fetch(req(), { UUID, EXPIRE_DATE: 'tomorrow', D1: new D1() }, context());
  assert.equal(r3.status, 503); assert.match(await r3.text(), /EXPIRE_DATE/);
  const head = await worker.fetch(new Request('https://worker.example/' + UUID + '/usage', { method: 'HEAD' }), env(), context());
  assert.equal(head.status, 200);
});
