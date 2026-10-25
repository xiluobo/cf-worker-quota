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

test('page embeds QR codes for subscriptions only', async () => {
  const res = await worker.fetch(new Request('https://worker.example/' + UUID), env(), context());
  assert.equal(res.status, 200);
  const html = await res.text();
  // 6 个组合订阅 + 13 个单节点订阅 = 19 个二维码
  const count = (html.match(/<details><summary>二维码<\/summary><svg /g) || []).length;
  assert.equal(count, 19, 'page has 19 QR codes for subscription links');
  // 节点 URI（vless://）不带二维码，只带复制按钮
  assert.ok(html.includes('vless://'), 'page still lists node URIs');
});
