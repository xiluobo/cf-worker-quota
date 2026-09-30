// VLESS over WebSocket; derived from the user-provided GAMFC/43fad05 source.
// Strict quota mode: persist authorized payload bytes BEFORE forwarding them.
// UUID and D1 are required. Run schema.sql once before deployment.
import { connect } from 'cloudflare:sockets';

const GIB = 1024 ** 3;
const MAX_QUEUE = 2 * 1024 ** 2;
const CHUNK = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_HOSTS = ['www.visa.com', 'cis.visa.com', 'africa.visa.com', 'www.visa.com.sg', 'www.visaeurope.at', 'www.visa.com.mt', 'qa.visamiddleeast.com', 'usa.visa.com', 'myanmar.visa.com', 'www.visa.com.tw', 'www.visaeurope.ch', 'www.visa.com.br', 'www.visasoutheasteurope.com'];
const DEFAULT_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095, 443, 8443, 2053, 2083, 2087, 2096];
const TYPES = new Set(['', 'ty', 'pty', 'cl', 'pcl', 'sb', 'psb', 'usage']);

class PublicError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function validHost(value) {
  const s = String(value).trim().replace(/^\[|\]$/g, '');
  if (!s || s.length > 253 || /[\s/?#@\\]/.test(s)) throw new PublicError('Invalid host', 503);
  if (s.includes(':')) {
    try { new URL('http://[' + s + ']/'); } catch { throw new PublicError('Invalid IPv6 address', 503); }
  } else if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(s) || s.split('.').some(p => !p || p.length > 63 || p.startsWith('-') || p.endsWith('-'))) {
    throw new PublicError('Invalid hostname', 503);
  }
  return s;
}

export function parseEndpoint(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(?:\[([0-9a-f:]+)\]|([^:\s]+))(?::(\d+))?$/i);
  if (!match) throw new PublicError('Invalid proxyip; use host:port or [IPv6]:port', 503);
  return { hostname: validHost(match[1] || match[2]), port: portNumber(match[3] || 443) };
}

function portNumber(value) {
  const p = Number(value);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new PublicError('Invalid port', 503);
  return p;
}

export function expiryMs(value = '2026-12-31') {
  const s = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) throw new PublicError('EXPIRE_DATE requires a date or an ISO timestamp with timezone', 503);
  const calendar = new Date(s.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== s.slice(0, 10)) throw new PublicError('Invalid EXPIRE_DATE', 503);
  const t = Date.parse(dateOnly ? s + 'T23:59:59.999Z' : s);
  if (!Number.isFinite(t)) throw new PublicError('Invalid EXPIRE_DATE', 503);
  return t;
}

export function readConfig(env) {
  const uuid = String(env.uuid || env.UUID || '').trim().toLowerCase();
  if (!UUID_RE.test(uuid)) throw new PublicError('Configure one valid UUID v4 in UUID', 503);
  const gb = Number(env.TOTAL_TRAFFIC ?? 100);
  const total = Math.floor(gb * GIB);
  if (!Number.isFinite(gb) || gb < 0 || !Number.isSafeInteger(total)) throw new PublicError('Invalid TOTAL_TRAFFIC', 503);
  const info = resolveCountry(env.COUNTRY || 'US');
  const country = (info.cn + info.flag).slice(0, 100);
  const tlsOnly = String(env.TLS_ONLY ?? 'false').toLowerCase() === 'true';
  return Object.freeze({
    uuid, total, expires: expiryMs(env.EXPIRE_DATE), country, tlsOnly,
    proxy: parseEndpoint(env.proxyip),
    cdnip: validHost(env.cdnip || 'www.visa.com.sg'),
    nodes: DEFAULT_HOSTS.map((h, i) => ({
      host: validHost(env['ip' + (i + 1)] || h), port: portNumber(env['pt' + (i + 1)] || DEFAULT_PORTS[i]),
      tls: i >= 7, name: country + '-' + (i + 1)
    }))
  });
}

export function utf8Base64(text) {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function equalUUID(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function response(body, status = 200, type = 'text/plain; charset=utf-8', extra = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', ...extra
  }});
}

export async function getUsage(db, cfg) {
  const row = await db.prepare('SELECT used_bytes FROM traffic WHERE uuid = ?').bind(cfg.uuid).first();
  const used = Number(row?.used_bytes ?? 0);
  if (!Number.isSafeInteger(used) || used < 0) throw new PublicError('Invalid stored usage', 503);
  return { used, total: cfg.total, remaining: Math.max(0, cfg.total - used), expires: cfg.expires,
    remainingDays: Math.max(0, (cfg.expires - Date.now()) / 86400000),
    expired: Date.now() >= cfg.expires, exhausted: used >= cfg.total };
}

// Each statement is atomic across concurrent connections and Worker isolates.
// No automatic retry: an ambiguous write must not accidentally charge twice.
export async function charge(db, cfg, bytes) {
  if (Date.now() >= cfg.expires) throw new PublicError('Subscription expired', 403);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid byte count');
  if (!bytes) return;
  if (bytes > cfg.total) throw new PublicError('Quota exhausted', 403);
  const row = await db.prepare(`INSERT INTO traffic (uuid, used_bytes, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(uuid) DO UPDATE SET used_bytes = traffic.used_bytes + excluded.used_bytes,
    updated_at = excluded.updated_at WHERE traffic.used_bytes <= ? - excluded.used_bytes
    RETURNING used_bytes`).bind(cfg.uuid, bytes, Date.now(), cfg.total).first();
  if (!row) throw new PublicError('Quota exhausted', 403);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const cfg = readConfig(env);
      const url = new URL(request.url);
      const ws = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      if (request.method !== 'GET') return response('Method not allowed', 405, undefined, { Allow: 'GET' });
      if (!ws) {
        const parts = url.pathname.split('/');
        if (parts.length < 2 || parts.length > 3 || !equalUUID(parts[1], cfg.uuid) || !TYPES.has(parts[2] || '')) return response('Not found', 404);
      } else if (url.pathname !== '/' && url.pathname !== '/ws') {
        return response('Not found', 404); // Client-supplied ProxyIP overrides are deliberately removed.
      }
      if (!env.D1) throw new PublicError('D1 binding required for quota enforcement', 503);
      // Primary-constrained reads avoid stale quota displays when read replication is enabled.
      const db = env.D1.withSession('first-primary');
      const usage = await getUsage(db, cfg);
      if (ws) {
        if (usage.expired || usage.exhausted) return response(usage.expired ? 'Subscription expired' : 'Quota exhausted', 403);
        return openTunnel(request, cfg, db, ctx);
      }
      const kind = url.pathname.split('/')[2] || '';
      if (kind === 'usage') return response(JSON.stringify(usage), 200, 'application/json; charset=utf-8');
      const host = url.hostname;
      const headers = {
        // Legacy usage has no directional split. Report its aggregate as download.
        'Subscription-Userinfo': `upload=0; download=${usage.used}; total=${cfg.total}; expire=${Math.floor(cfg.expires / 1000)}`,
        'Profile-Update-Interval': '6', 'Profile-Title': 'base64:' + utf8Base64(cfg.country),
        'Profile-Web-Page-Url': url.origin + '/' + cfg.uuid
      };
      if (!kind) return renderPage(cfg, usage, url.origin);
      const nodes = cfg.nodes.filter(n => !(cfg.tlsOnly || kind.startsWith('p')) || n.tls);
      if (kind.endsWith('ty')) return response(utf8Base64(nodes.map(n => vlessURI(cfg, host, n)).join('\n')), 200, undefined, headers);
      if (kind.endsWith('cl')) return response(clashConfig(cfg, host, nodes), 200, 'text/yaml; charset=utf-8', headers);
      return response(JSON.stringify(singboxConfig(cfg, host, nodes), null, 2), 200, 'application/json; charset=utf-8', headers);
    } catch (error) {
      const known = error instanceof PublicError;
      console.error(JSON.stringify({ event: 'request_failed', category: known ? error.message : 'storage_or_runtime_error' }));
      return response(known ? error.message : 'Service temporarily unavailable', known ? error.status : 503);
    }
  }
};

// Returns null until the entire header is available, including fragmented headers.
export function parseVless(data, uuid) {
  if (data.length < 18) return null;
  if (data[0] !== 0) throw new PublicError('Unsupported VLESS version');
  const hex = Array.from(data.subarray(1, 17), b => b.toString(16).padStart(2, '0')).join('');
  const supplied = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  if (!equalUUID(supplied, uuid)) throw new PublicError('Invalid user', 403);
  let p = 18 + data[17];
  if (data.length < p + 4) return null;
  const command = data[p++];
  if (command !== 1 && command !== 2) throw new PublicError('Unsupported command');
  const port = (data[p++] << 8) | data[p++];
  if (!port) throw new PublicError('Invalid destination port');
  if (command === 2 && port !== 53) throw new PublicError('Only DNS UDP is supported');
  const type = data[p++];
  let host;
  if (type === 1) {
    if (data.length < p + 4) return null;
    host = Array.from(data.subarray(p, p + 4)).join('.'); p += 4;
  } else if (type === 2) {
    if (data.length < p + 1) return null;
    const n = data[p++];
    if (!n) throw new PublicError('Empty destination');
    if (data.length < p + n) return null;
    host = validHost(decoder.decode(data.subarray(p, p + n))); p += n;
  } else if (type === 3) {
    if (data.length < p + 16) return null;
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((data[p + i] << 8) | data[p + i + 1]).toString(16));
    host = groups.join(':'); p += 16;
  } else throw new PublicError('Unsupported address type');
  return { host, port, dns: command === 2, payload: data.subarray(p) };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out;
}

export function decodeEarlyData(value) {
  if (!value) return new Uint8Array();
  if (value.length > 8192 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new PublicError('Invalid early data');
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
  catch { throw new PublicError('Invalid early data'); }
}

function openTunnel(request, cfg, db, ctx) {
  const early = decodeEarlyData(request.headers.get('sec-websocket-protocol'));
  const pair = new WebSocketPair();
  const client = pair[0], ws = pair[1];
  ws.accept();
  let stopped = false, pending = 0, header = new Uint8Array(), dnsBuffer = new Uint8Array();
  let destination = null, socket = null, writer = null, sentHeader = false;
  let chain = Promise.resolve(), expiryTimer, idleTimer;
  const abort = new AbortController();
  function stop(code = 1000, reason = 'Connection closed') {
    if (stopped) return;
    stopped = true;
    clearTimeout(expiryTimer); clearTimeout(idleTimer); abort.abort();
    if (socket) void socket.close().catch(() => {});
    try { ws.close(code, reason); } catch {}
  }
  function touch() { clearTimeout(idleTimer); idleTimer = setTimeout(() => stop(1000, 'Idle timeout'), 120000); }
  function scheduleExpiry() {
    const left = cfg.expires - Date.now();
    if (left <= 0) return stop(1008, 'Subscription expired');
    expiryTimer = setTimeout(scheduleExpiry, Math.min(left, 2147483647));
  }
  function fail(error) {
    stop(error instanceof PublicError ? 1008 : 1011, error instanceof PublicError ? error.message : 'Upstream or accounting failure');
  }
  async function authorize(n) {
    if (stopped) throw new PublicError('Connection closed');
    await charge(db, cfg, n);
    if (stopped || Date.now() >= cfg.expires) throw new PublicError('Subscription expired or connection closed');
    touch();
  }
  async function send(data, dns = false) {
    for (let p = 0; p < data.length; p += CHUNK) {
      const bytes = data.subarray(p, p + CHUNK);
      await authorize(bytes.length);
      let framed = bytes;
      if (dns) framed = concat(new Uint8Array([bytes.length >> 8, bytes.length & 255]), bytes);
      if (!sentHeader) { framed = concat(new Uint8Array([0, 0]), framed); sentHeader = true; }
      ws.send(framed);
    }
  }
  async function openSocket(host, port) {
    const candidate = connect({ hostname: host, port });
    socket = candidate;
    void candidate.closed.catch(() => {});
    let timer;
    try {
      await Promise.race([candidate.opened, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Connect timeout')), 10000); })]);
      if (stopped) throw new Error('Connection closed');
      return candidate;
    } catch (error) { void candidate.close().catch(() => {}); throw error; }
    finally { clearTimeout(timer); }
  }
  async function startTCP() {
    try { await openSocket(destination.host, destination.port); }
    catch (error) {
      if (stopped || !cfg.proxy) throw error;
      await openSocket(cfg.proxy.hostname, cfg.proxy.port);
    }
    writer = socket.writable.getWriter();
    const pump = (async () => {
      const reader = socket.readable.getReader();
      try {
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          await send(value);
        }
        stop();
      } finally { reader.releaseLock(); }
    })().catch(fail);
    ctx.waitUntil(pump);
  }
  async function dnsData(bytes) {
    dnsBuffer = concat(dnsBuffer, bytes);
    while (dnsBuffer.length >= 2) {
      const length = (dnsBuffer[0] << 8) | dnsBuffer[1];
      if (length < 12) throw new PublicError('Invalid DNS packet');
      if (dnsBuffer.length < length + 2) return;
      const packet = dnsBuffer.slice(2, length + 2);
      dnsBuffer = dnsBuffer.slice(length + 2);
      await authorize(packet.length);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      abort.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, 10000);
      try {
        const result = await fetch('https://cloudflare-dns.com/dns-query', {
          method: 'POST', headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message' },
          body: packet, signal: controller.signal, redirect: 'error'
        });
        if (!result.ok || !result.body || !result.headers.get('Content-Type')?.includes('application/dns-message')) throw new Error('DNS upstream failed');
        const reader = result.body.getReader();
        let answer = new Uint8Array();
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            if (answer.length + value.length > 65535) { await reader.cancel(); throw new Error('DNS response too large'); }
            answer = concat(answer, value);
          }
        } finally { reader.releaseLock(); }
        if (answer.length < 12) throw new Error('Invalid DNS response');
        await send(answer, true);
      } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); }
    }
  }
  async function consume(bytes) {
    if (stopped) return;
    if (!destination) {
      header = concat(header, bytes);
      destination = parseVless(header, cfg.uuid);
      if (!destination) { if (header.length > 1024) throw new PublicError('Header too large'); return; }
      bytes = destination.payload; header = new Uint8Array();
      if (!destination.dns) await startTCP();
    }
    if (destination.dns) return dnsData(bytes);
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const part = bytes.subarray(i, i + CHUNK);
      await authorize(part.length);
      await writer.write(part);
    }
  }
  function enqueue(data) {
    if (stopped) return;
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return stop(1003, 'Binary frames required');
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (pending + bytes.length > MAX_QUEUE) return stop(1009, 'Receive queue limit exceeded');
    pending += bytes.length;
    chain = chain.then(() => consume(bytes)).catch(fail).finally(() => { pending -= bytes.length; });
    ctx.waitUntil(chain);
  }
  ws.addEventListener('message', event => enqueue(event.data));
  ws.addEventListener('close', () => stop());
  ws.addEventListener('error', () => stop(1011, 'WebSocket error'));
  scheduleExpiry(); touch();
  if (early.length) enqueue(early);
  return new Response(null, { status: 101, webSocket: client });
}

export function vlessURI(cfg, host, node) {
  const params = new URLSearchParams({ encryption: 'none', security: node.tls ? 'tls' : 'none', type: 'ws', host, path: '/?ed=2560' });
  if (node.tls) { params.set('sni', host); params.set('fp', 'chrome'); }
  const address = node.host.includes(':') ? '[' + node.host + ']' : node.host;
  return `vless://${cfg.uuid}@${address}:${node.port}?${params}#${encodeURIComponent(node.name)}`;
}

export function clashConfig(cfg, host, nodes) {
  // JSON is also valid YAML; avoids interpolation/escaping bugs in node names.
  const names = nodes.map(n => n.name);
  return JSON.stringify({
    'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'info',
    'unified-delay': true, 'global-client-fingerprint': 'chrome',
    proxies: nodes.map(n => ({ name: n.name, type: 'vless', server: n.host, port: n.port, uuid: cfg.uuid,
      udp: false, tls: n.tls, network: 'ws', ...(n.tls ? { servername: host } : {}),
      'ws-opts': { path: '/?ed=2560', headers: { Host: host } } })),
    'proxy-groups': [
      { name: '自动选择', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 300, tolerance: 50, proxies: names },
      { name: '负载均衡', type: 'load-balance', strategy: 'consistent-hashing', url: 'https://www.gstatic.com/generate_204', interval: 300, proxies: names },
      { name: '选择代理', type: 'select', proxies: ['自动选择', '负载均衡', 'DIRECT', ...names] }
    ],
    rules: ['IP-CIDR,127.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve', 'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve', 'GEOIP,CN,DIRECT', 'MATCH,选择代理']
  }, null, 2);
}

export function singboxConfig(cfg, host, nodes) {
  const tags = nodes.map(n => n.name);
  const ruleBase = 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/';
  return {
    log: { level: 'info', timestamp: true },
    dns: { servers: [{ type: 'https', tag: 'localdns', server: '223.5.5.5', path: '/dns-query', detour: 'direct' },
      { type: 'https', tag: 'proxydns', server: '1.1.1.1', path: '/dns-query', detour: 'select' }],
      rules: [{ rule_set: 'geosite-cn', server: 'localdns' }], final: 'proxydns' },
    inbounds: [{ type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30', 'fd00::1/126'], auto_route: true, strict_route: true }],
    outbounds: [{ type: 'selector', tag: 'select', default: 'auto', outbounds: ['auto', ...tags] },
      { type: 'urltest', tag: 'auto', outbounds: tags, url: 'https://www.gstatic.com/generate_204', interval: '5m', tolerance: 50 },
      ...nodes.map(n => ({ type: 'vless', tag: n.name, server: n.host, server_port: n.port, uuid: cfg.uuid,
        network: 'tcp', transport: { type: 'ws', path: '/?ed=2560', headers: { Host: host } },
        ...(n.tls ? { tls: { enabled: true, server_name: host, utls: { enabled: true, fingerprint: 'chrome' } } } : {}) })),
      { type: 'direct', tag: 'direct' }],
    route: { auto_detect_interface: true, default_domain_resolver: 'localdns', final: 'select',
      rule_set: [{ type: 'remote', tag: 'geoip-cn', format: 'binary', url: ruleBase + 'geoip/cn.srs', download_detour: 'select', update_interval: '1d' },
        { type: 'remote', tag: 'geosite-cn', format: 'binary', url: ruleBase + 'geosite/cn.srs', download_detour: 'select', update_interval: '1d' }],
      rules: [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' },
        { network: 'udp', action: 'reject' }, { ip_is_private: true, outbound: 'direct' },
        { rule_set: ['geoip-cn', 'geosite-cn'], outbound: 'direct' }]
    }
  };
}

function escapeHTML(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function renderPage(cfg, usage, origin) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const e = escapeHTML;
  const status = usage.expired ? '已到期' : usage.exhausted ? '流量已用尽' : '可用';
  const links = [['通用订阅', 'ty'], ['Clash Meta', 'cl'], ['Sing-box', 'sb'], ['通用订阅 · 仅 TLS', 'pty'], ['Clash Meta · 仅 TLS', 'pcl'], ['Sing-box · 仅 TLS', 'psb']];
  const single = [{ host: cfg.cdnip, port: 8443, tls: true, name: cfg.country }];
  if (!cfg.tlsOnly) single.push({ host: cfg.cdnip, port: 8880, tls: false, name: cfg.country });
  const fields = [...links.map(([name, suffix]) => [name, origin + '/' + cfg.uuid + '/' + suffix]),
    ...single.map(n => [n.tls ? '单节点 · TLS' : '单节点 · 非 TLS', vlessURI(cfg, new URL(origin).hostname, n)])];
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>节点与订阅</title>
  <style nonce="${nonce}">*{box-sizing:border-box}body{font:16px/1.6 system-ui;margin:0;background:#f2f5f9;color:#172437}main{max-width:850px;margin:40px auto;padding:24px}section{background:white;padding:24px;border-radius:16px;margin:18px 0}h1{margin:0}small{color:#526273}label{display:block;margin-top:16px}input{width:calc(100% - 80px);padding:10px;border:1px solid #bcc8d7;border-radius:6px}button{margin-left:8px;padding:10px;border:0;border-radius:6px;background:#145ad3;color:white;cursor:pointer}progress{width:100%;height:18px}#notice{min-height:26px}</style></head>
  <body><main><h1>${e(cfg.country)} · ${status}</h1><section><strong>剩余 ${(usage.remaining / GIB).toFixed(2)} GiB / ${(cfg.total / GIB).toFixed(2)} GiB</strong><progress max="${Math.max(cfg.total,1)}" value="${Math.min(usage.used,cfg.total)}"></progress><p>剩余 ${usage.remainingDays.toFixed(1)} 天 · 到期 ${e(new Date(cfg.expires).toISOString())}</p><small>额度统计上传与下载的有效载荷。请保管好这些链接；其中包含连接凭据。国家名称仅为标签。</small></section>
  <section><h2>订阅与节点</h2>${fields.map(([name,value],i) => `<label for="link-${i}">${e(name)}</label><input id="link-${i}" readonly value="${e(value)}"><button data-copy="link-${i}">复制</button>`).join('')}<p id="notice" role="status"></p></section></main>
  <script nonce="${nonce}">document.addEventListener('click',async event=>{const id=event.target.dataset.copy;if(!id)return;const input=document.getElementById(id);try{await navigator.clipboard.writeText(input.value);document.getElementById('notice').textContent='已复制';}catch{input.focus();input.select();document.getElementById('notice').textContent='请按 Ctrl+C 复制';}});</script></body></html>`;
  return response(html, 200, 'text/html; charset=utf-8', { 'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
}

const COUNTRY_MAP = {
  US: "美国", CN: "中国", HK: "香港", TW: "台湾", MO: "澳门",
  JP: "日本", KR: "韩国", KP: "朝鲜", SG: "新加坡", MY: "马来西亚",
  TH: "泰国", VN: "越南", PH: "菲律宾", ID: "印度尼西亚", IN: "印度",
  GB: "英国", UK: "英国", DE: "德国", FR: "法国", IT: "意大利",
  ES: "西班牙", PT: "葡萄牙", NL: "荷兰", BE: "比利时", CH: "瑞士",
  AT: "奥地利", SE: "瑞典", NO: "挪威", DK: "丹麦", FI: "芬兰",
  IS: "冰岛", IE: "爱尔兰", PL: "波兰", CZ: "捷克", SK: "斯洛伐克",
  HU: "匈牙利", RO: "罗马尼亚", BG: "保加利亚", GR: "希腊", HR: "克罗地亚",
  RS: "塞尔维亚", SI: "斯洛文尼亚", LT: "立陶宛", LV: "拉脱维亚", EE: "爱沙尼亚",
  RU: "俄罗斯", UA: "乌克兰", BY: "白俄罗斯", TR: "土耳其", IL: "以色列",
  SA: "沙特阿拉伯", AE: "阿联酋", QA: "卡塔尔", KW: "科威特", IR: "伊朗",
  IQ: "伊拉克", EG: "埃及", ZA: "南非", NG: "尼日利亚", KE: "肯尼亚",
  MA: "摩洛哥", DZ: "阿尔及利亚", TN: "突尼斯", ET: "埃塞俄比亚", GH: "加纳",
  BR: "巴西", AR: "阿根廷", CL: "智利", MX: "墨西哥", CO: "哥伦比亚",
  PE: "秘鲁", VE: "委内瑞拉", EC: "厄瓜多尔", UY: "乌拉圭", PY: "巴拉圭",
  CA: "加拿大", AU: "澳大利亚", NZ: "新西兰", PK: "巴基斯坦", BD: "孟加拉国",
  LK: "斯里兰卡", NP: "尼泊尔", KH: "柬埔寨", LA: "老挝", MM: "缅甸",
  MN: "蒙古", KZ: "哈萨克斯坦", UZ: "乌兹别克斯坦", AF: "阿富汗", GE: "格鲁吉亚",
  AM: "亚美尼亚", AZ: "阿塞拜疆"
};

const CN_TO_CODE = {};
for (const [code, cn] of Object.entries(COUNTRY_MAP)) {
  if (!CN_TO_CODE[cn]) CN_TO_CODE[cn] = code;
}

function codeToFlag(code) {
  if (!/^[A-Za-z]{2}$/.test(code)) return "";
  const c = code.toUpperCase();
  return String.fromCodePoint(
    0x1F1E6 + c.charCodeAt(0) - 65,
    0x1F1E6 + c.charCodeAt(1) - 65
  );
}

// 解析国家：支持 英文代码(大小写)、中文名、国旗emoji、混合写法
function resolveCountry(input) {
  if (!input) return { code: "US", cn: "美国", flag: "🇺🇸" };
  const raw = String(input).trim();

  const flagMatch = raw.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  const flagEmoji = flagMatch ? flagMatch[0] : "";
  let rest = raw.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, "").trim();

  let code = "";
  let cn = "";

  if (/^[A-Za-z]{2}$/.test(rest)) {
    code = rest.toUpperCase();
    const realCode = code === "UK" ? "GB" : code;
    cn = COUNTRY_MAP[code] || COUNTRY_MAP[realCode] || "";
    code = realCode;
  } else if (CN_TO_CODE[rest]) {
    code = CN_TO_CODE[rest];
    cn = rest;
  } else if (rest) {
    cn = rest;
  }

  // 只有国旗时反查代码
  if (!code && flagEmoji) {
    for (const c of Object.keys(COUNTRY_MAP)) {
      if (codeToFlag(c) === flagEmoji) {
        code = c;
        cn = COUNTRY_MAP[c] || "";
        break;
      }
    }
  }

  if (!cn) cn = code ? (COUNTRY_MAP[code] || code) : "";
  const flag = flagEmoji || codeToFlag(code);
  return { code, cn: cn || flag || "", flag };
}

