import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const moduleSource = source.replace("import { connect } from 'cloudflare:sockets';", 'const connect = (...args) => globalThis.__connect(...args);');
const mod = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
const worker = mod.default;
const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('CREATE TABLE traffic(uuid TEXT PRIMARY KEY,used_bytes INTEGER DEFAULT 0,updated_at INTEGER)');
    this.calls = 0;
  }
  withSession() { return this; }
  prepare(sql) {
    const stmt = this.sqlite.prepare(sql);
    return { bind: (...args) => ({ first: async () => { this.calls++; return stmt.get(...args) || null; } }) };
  }
  used(uuid = UUID) { return this.sqlite.prepare('SELECT used_bytes FROM traffic WHERE uuid=?').get(uuid)?.used_bytes || 0; }
}
function env(extra = {}) { return { UUID, TOTAL_TRAFFIC: '1', EXPIRE_DATE: '2099-12-31', D1: new D1(), ...extra }; }
function context() { return { promises: [], waitUntil(p) { this.promises.push(p); } }; }
function packet(uuid = UUID, payload = [], command = 1, address = [1, 1, 2, 3, 4], port = 443) {
  const id = Buffer.from(uuid.replaceAll('-', ''), 'hex');
  return Uint8Array.from([0, ...id, 0, command, port >> 8, port & 255, ...address, ...payload]);
}
async function request(e, suffix = '', options = {}) {
  return worker.fetch(new Request('https://worker.example/' + (e.UUID || UUID) + suffix, options), e, context());
}

test('configuration is isolated, validates UUID/date/quota and accepts zero', () => {
  const one = mod.readConfig(env({ COUNTRY: 'JP', ip1: 'first.example' }));
  const two = mod.readConfig(env({ UUID: UUID2, COUNTRY: 'US' }));
  assert.equal(one.country, '日本🇯🇵'); assert.equal(two.country, '美国🇺🇸');
  assert.notEqual(two.nodes[0].host, 'first.example');
  assert.equal(mod.readConfig(env({ TOTAL_TRAFFIC: '0' })).total, 0);
  for (const invalid of ['', 'no', UUID + ',' + UUID2]) assert.throws(() => mod.readConfig(env({ UUID: invalid })));
  for (const date of ['2026-02-30', 'bad', '2026-12-31T23:00:00']) assert.throws(() => mod.expiryMs(date));
  assert.equal(mod.expiryMs('2026-12-31'), Date.parse('2026-12-31T23:59:59.999Z'));
  assert.equal(mod.expiryMs('2026-12-31T23:00:00+08:00'), Date.parse('2026-12-31T15:00:00Z'));
  for (const value of [-1, 'NaN', Infinity]) assert.throws(() => mod.readConfig(env({ TOTAL_TRAFFIC: value })));
});

test('endpoints validate ports and IPv6; Unicode encoding round-trips', () => {
  assert.deepEqual(mod.parseEndpoint('[2001:db8::1]:8443'), { hostname: '2001:db8::1', port: 8443 });
  assert.equal(mod.parseEndpoint('proxy.example').port, 443);
  for (const s of ['https://example.com', 'host:0', 'host:99999', 'a b', '[bad::ip]']) assert.throws(() => mod.parseEndpoint(s));
  assert.equal(Buffer.from(mod.utf8Base64('美国🇺🇸-1'), 'base64').toString('utf8'), '美国🇺🇸-1');
});

test('all six subscriptions generate correct node counts and usage metadata', async () => {
  const e = env();
  for (const kind of ['ty', 'pty', 'cl', 'pcl', 'sb', 'psb']) {
    const res = await request(e, '/' + kind);
    assert.equal(res.status, 200, kind);
    assert.match(res.headers.get('Subscription-Userinfo'), /upload=0; download=0; total=1073741824;/);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const text = await res.text();
    const count = kind.startsWith('p') ? 6 : 13;
    if (kind.endsWith('ty')) {
      const links = Buffer.from(text, 'base64').toString('utf8').split('\n');
      assert.equal(links.length, count);
      assert.equal(decodeURIComponent(new URL(links[0]).hash.slice(1)), '美国🇺🇸-' + (kind.startsWith('p') ? 8 : 1));
    } else if (kind.endsWith('cl')) {
      const cfg = JSON.parse(text); assert.equal(cfg.proxies.length, count); assert.equal(cfg['allow-lan'], false);
    } else {
      const cfg = JSON.parse(text); assert.equal(cfg.outbounds.filter(o => o.type === 'vless').length, count);
      assert.equal(cfg.dns.servers[0].type, 'https');
      assert.equal(cfg.route.default_domain_resolver, 'localdns');
    }
  }
  const tls = await request(env({ TLS_ONLY: 'true' }), '/ty');
  assert.equal(Buffer.from(await tls.text(), 'base64').toString().split('\n').length, 6);
});

test('HTML escapes labels and exposes no external scripts; unknown routes do not access D1', async () => {
  const e = env({ COUNTRY: '<img src=x onerror=alert(1)>' });
  const res = await request(e);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img'));
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const calls = e.D1.calls;
  assert.equal((await worker.fetch(new Request('https://worker.example/'), e, context())).status, 404);
  assert.equal(e.D1.calls, calls);
  assert.equal((await request(e, '', { method: 'POST' })).status, 405);
});

test('missing/broken D1 fails closed; expired usage remains inspectable', async () => {
  assert.equal((await request(env({ D1: null }))).status, 503);
  assert.equal((await request(env({ D1: { withSession() { throw new Error('DB outage'); } } }))).status, 503);
  const res = await request(env({ EXPIRE_DATE: '2000-01-01' }), '/usage');
  assert.equal(res.status, 200); assert.equal((await res.json()).expired, true);
});

test('atomic SQL enforces concurrent quota and preserves old traffic', async () => {
  const e = env(), cfg = { ...mod.readConfig(e), total: 100 };
  e.D1.sqlite.prepare('INSERT INTO traffic VALUES(?,?,?)').run(UUID, 10, 0);
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => mod.charge(e.D1, cfg, 10)));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 9);
  assert.equal(e.D1.used(), 100);
  await assert.rejects(() => mod.charge(e.D1, cfg, 1), /Quota/);
  await assert.rejects(() => mod.charge(e.D1, { ...cfg, expires: 0 }, 1), /expired/);
  const empty = new D1();
  await assert.rejects(() => mod.charge(empty, { ...cfg, total: 0 }, 1)); assert.equal(empty.used(), 0);
});

test('VLESS parser handles fragmentation, IPv4, domains and IPv6; rejects wrong UUID/UDP', () => {
  const full = packet(UUID, [1, 2, 3]);
  for (let n = 0; n < full.length - 3; n++) assert.equal(mod.parseVless(full.subarray(0, n), UUID), null);
  const parsed = mod.parseVless(full, UUID);
  assert.equal(parsed.host, '1.2.3.4'); assert.deepEqual([...parsed.payload], [1,2,3]);
  const name = Buffer.from('example.com');
  assert.equal(mod.parseVless(packet(UUID, [], 1, [2, name.length, ...name]), UUID).host, 'example.com');
  assert.equal(mod.parseVless(packet(UUID, [], 1, [3, ...Array(16).fill(0)]), UUID).host, '0:0:0:0:0:0:0:0');
  assert.throws(() => mod.parseVless(packet(UUID2), UUID), /Invalid user/);
  assert.throws(() => mod.parseVless(packet(UUID, [], 2), UUID), /Only DNS/);
  assert.equal(mod.parseVless(packet(UUID, [], 2, [1,8,8,8,8], 53), UUID).dns, true);
  assert.throws(() => mod.decodeEarlyData('%%%'));
  assert.deepEqual([...mod.decodeEarlyData(Buffer.from(full).toString('base64url'))], [...full]);
});

class FakeSocket extends EventTarget {
  readyState = 1; sent = []; code = null;
  accept() {}
  send(data) { this.sent.push(new Uint8Array(data)); }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.code = code; this.dispatchEvent(new Event('close')); }
  receive(bytes) { this.dispatchEvent(new MessageEvent('message', { data: bytes })); }
}
let serverWS;
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeSocket(); serverWS = this[1] = new FakeSocket(); } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse {
  constructor(body, options = {}) {
    super(body, options.status === 101 ? { ...options, status: 200 } : options);
    if (options.status === 101) { Object.defineProperty(this, 'status', { value: 101 }); this.webSocket = options.webSocket; }
  }
};
function echoConnect() {
  let controller;
  let resolveClosed;
  let closed = false;
  const readable = new ReadableStream({ start(c) { controller = c; } });
  return { readable, opened: Promise.resolve({}), closed: new Promise(r => { resolveClosed = r; }),
    writable: new WritableStream({ write(bytes) { controller.enqueue(bytes.slice()); } }),
    async close() { if (!closed) { closed = true; controller.close(); resolveClosed(); } }
  };
}
async function tunnel(e, header) {
  const ctx = context();
  const res = await worker.fetch(new Request('https://worker.example/?ed=2560', { headers: { Upgrade: 'websocket', ...(header ? { 'sec-websocket-protocol': header } : {}) } }), e, ctx);
  return { res, ctx, ws: serverWS };
}
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(5); } throw new Error('Test condition timed out'); }

test('TCP includes first upload and download, fragmented header and clean shutdown', async () => {
  globalThis.__connect = echoConnect;
  const e = env(); const { res, ws, ctx } = await tunnel(e);
  assert.equal(res.status, 101);
  const first = packet(UUID, [10,20,30]);
  ws.receive(first.slice(0,10)); ws.receive(first.slice(10));
  await until(() => ws.sent.length === 1);
  assert.deepEqual([...ws.sent[0]], [0,0,10,20,30]); assert.equal(e.D1.used(), 6);
  ws.receive(new Uint8Array([40,50])); await until(() => ws.sent.length === 2);
  assert.deepEqual([...ws.sent[1]], [40,50]); assert.equal(e.D1.used(), 10);
  ws.close(); await Promise.allSettled(ctx.promises);
});

test('quota blocks payload BEFORE socket write and rejects new connections', async () => {
  globalThis.__connect = echoConnect;
  const e = env({ TOTAL_TRAFFIC: String(2 / 1024 ** 3) });
  const { ws, ctx } = await tunnel(e);
  ws.receive(packet(UUID, [1,2,3])); await until(() => ws.readyState === 3);
  assert.equal(ws.code, 1008); assert.equal(e.D1.used(), 0); assert.equal(ws.sent.length, 0);
  await Promise.allSettled(ctx.promises);
  e.D1.sqlite.prepare('INSERT INTO traffic VALUES(?,?,?)').run(UUID, 2, 0);
  assert.equal((await tunnel(e)).res.status, 403);
  assert.equal((await tunnel(env({ EXPIRE_DATE: '2000-01-01' }))).res.status, 403);
});

test('existing connections expire and wrong users never connect upstream', async () => {
  let connections = 0;
  globalThis.__connect = (...args) => { connections++; return echoConnect(...args); };
  const { ws, ctx } = await tunnel(env());
  ws.receive(packet(UUID2, [1])); await until(() => ws.readyState === 3);
  assert.equal(connections, 0); await Promise.allSettled(ctx.promises);
  const active = await tunnel(env({ EXPIRE_DATE: new Date(Date.now() + 500).toISOString() }));
  active.ws.receive(packet(UUID, [1])); await until(() => active.ws.sent.length === 1);
  await until(() => active.ws.readyState === 3); assert.equal(active.ws.code, 1008);
  await Promise.allSettled(active.ctx.promises);
});

test('DNS handles fragmented framing and counts query plus response', async () => {
  const realFetch = globalThis.fetch;
  const answer = Uint8Array.from({ length: 12 }, (_, i) => i);
  let requests = 0;
  globalThis.fetch = async (_url, options) => { requests++; assert.equal(options.body.length, 12); return new Response(answer, { headers: { 'Content-Type': 'application/dns-message' } }); };
  try {
    const e = env(); const { ws, ctx } = await tunnel(e);
    ws.receive(packet(UUID, [0], 2, [1,8,8,8,8], 53));
    ws.receive(Uint8Array.from([12, ...answer.slice(0,4)]));
    ws.receive(answer.slice(4));
    await until(() => ws.sent.length === 1);
    assert.equal(requests, 1); assert.equal(e.D1.used(), 24);
    assert.deepEqual([...ws.sent[0]], [0,0,0,12,...answer]);
    ws.close(); await Promise.allSettled(ctx.promises);
  } finally { globalThis.fetch = realFetch; }
});

test('early data works and connect failure falls back once without replay', async () => {
  const attempted = [];
  globalThis.__connect = endpoint => {
    attempted.push(endpoint);
    if (attempted.length === 1) return { opened: Promise.reject(new Error('blocked')), closed: Promise.resolve(), close: async () => {} };
    return echoConnect();
  };
  const e = env({ proxyip: 'backup.example:8443' });
  const { ws, ctx } = await tunnel(e, Buffer.from(packet(UUID,[4,5])).toString('base64url'));
  await until(() => ws.sent.length === 1);
  assert.equal(attempted.length, 2); assert.equal(attempted[1].hostname, 'backup.example');
  assert.equal(e.D1.used(), 4); ws.close(); await Promise.allSettled(ctx.promises);
});

test('accounting failures, text frames and excessive buffers close the tunnel', async () => {
  globalThis.__connect = echoConnect;
  const e = env(); const first = await tunnel(e);
  e.D1.sqlite.close(); first.ws.receive(packet(UUID,[1]));
  await until(() => first.ws.readyState === 3); assert.equal(first.ws.code, 1011);
  await Promise.allSettled(first.ctx.promises);
  const text = await tunnel(env()); text.ws.receive('hello'); assert.equal(text.ws.code, 1003);
  const big = await tunnel(env()); big.ws.receive(new Uint8Array(2*1024**2+1)); assert.equal(big.ws.code, 1009);
});
