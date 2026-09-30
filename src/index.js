// Cloudflare Worker: authenticated VLESS over WebSocket with subscription endpoints.
// The worker intentionally keeps all configuration in environment variables so that
// secrets and deployment-specific values are not committed to the repository.

import { connect } from "cloudflare:sockets";

const DEFAULT_UUID = "86c50e3a-5b87-49dd-bd20-03c7f2735e40";
const DEFAULT_IPS = [
  "www.visa.com", "cis.visa.com", "africa.visa.com", "www.visa.com.sg",
  "www.visaeurope.at", "www.visa.com.mt", "qa.visamiddleeast.com",
  "usa.visa.com", "myanmar.visa.com", "www.visa.com.tw",
  "www.visaeurope.ch", "www.visa.com.br", "www.visasoutheasteurope.com"
];
const DEFAULT_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095, 443, 8443, 2053, 2083, 2087, 2096];
const DNS_URL = "https://cloudflare-dns.com/dns-query";
const OPEN = 1;

const COUNTRY_MAP = {
  US: "美国", CN: "中国", HK: "香港", TW: "台湾", JP: "日本", KR: "韩国", SG: "新加坡",
  GB: "英国", DE: "德国", FR: "法国", IT: "意大利", ES: "西班牙", PT: "葡萄牙",
  NL: "荷兰", CH: "瑞士", AT: "奥地利", RU: "俄罗斯", UA: "乌克兰", TR: "土耳其",
  BR: "巴西", CA: "加拿大", AU: "澳大利亚", NZ: "新西兰", IN: "印度", MY: "马来西亚",
  TH: "泰国", VN: "越南", ID: "印度尼西亚", PH: "菲律宾", AE: "阿联酋", ZA: "南非"
};

function flag(code) {
  if (!/^[A-Z]{2}$/i.test(code)) return "";
  return [...code.toUpperCase()].map(c => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

function country(value) {
  const raw = String(value || "US").trim();
  const emoji = raw.match(/[\u{1f1e6}-\u{1f1ff}]{2}/u)?.[0] || "";
  const rest = raw.replace(/[\u{1f1e6}-\u{1f1ff}]{2}/gu, "").trim();
  const code = /^[a-z]{2}$/i.test(rest) ? (rest.toUpperCase() === "UK" ? "GB" : rest.toUpperCase()) : "";
  const cn = COUNTRY_MAP[code] || (rest && !emoji ? rest : "美国");
  return `${cn}${emoji || flag(code || "US")}`;
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function uuids(env) {
  const value = String(env.UUID || env.uuid || DEFAULT_UUID);
  const list = value.split(",").map(v => v.trim()).filter(Boolean);
  if (!list.length || !list.every(validUuid)) throw new Error("Invalid UUID configuration");
  return list;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function parseEndpoint(value, fallback = "") {
  const input = String(value || fallback).trim();
  if (!input || input.length > 255 || /[\s/\\]/.test(input)) return null;
  let host = input, port = 443;
  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end < 0) return null;
    host = input.slice(1, end);
    if (input.slice(end + 1).startsWith(":")) port = Number(input.slice(end + 2));
  } else {
    const match = input.match(/^(.*?)(?::(\d+))?$/);
    host = match?.[1] || input;
    if (match?.[2]) port = Number(match[2]);
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[a-z0-9._:-]+$/i.test(host)) return null;
  return { host, port };
}

function getConfig(env, request) {
  const ids = uuids(env);
  const ips = Array.from({ length: 13 }, (_, i) => String(env[`ip${i + 1}`] || DEFAULT_IPS[i]));
  const ports = Array.from({ length: 13 }, (_, i) => Number(env[`pt${i + 1}`] || DEFAULT_PORTS[i]));
  if (ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error("Invalid port configuration");
  const host = request.headers.get("Host") || new URL(request.url).host;
  return { ids, uuid: ids[0], ips, ports, host, country: country(env.COUNTRY), cdnip: env.cdnip || DEFAULT_IPS[3], total: Number(env.TOTAL_TRAFFIC) > 0 ? Number(env.TOTAL_TRAFFIC) : 100, expire: env.EXPIRE_DATE || "2026-12-31" };
}

function vlessLine(cfg, i, tls) {
  const security = tls ? `security=tls&sni=${encodeURIComponent(cfg.host)}` : "security=none";
  return `vless://${cfg.uuid}@${cfg.ips[i]}:${cfg.ports[i]}?encryption=none&${security}&fp=randomized&type=ws&host=${encodeURIComponent(cfg.host)}&path=%2F%3Fed%3D2560#${encodeURIComponent(cfg.country)}-${i + 1}`;
}

function vlessList(cfg, tlsOnly = false) {
  const start = tlsOnly ? 7 : 0;
  return Array.from({ length: 13 - start }, (_, n) => vlessLine(cfg, n + start, n + start >= 7)).join("\n");
}

function yamlConfig(cfg, tlsOnly) {
  const start = tlsOnly ? 7 : 0;
  const proxies = Array.from({ length: 13 - start }, (_, n) => {
    const i = n + start, name = `${cfg.country}-${i + 1}`;
    return `- name: "${name}"\n  type: vless\n  server: ${cfg.ips[i]}\n  port: ${cfg.ports[i]}\n  uuid: ${cfg.uuid}\n  udp: false\n  tls: ${i >= 7}\n  network: ws\n  ${i >= 7 ? `servername: ${cfg.host}\n  ` : ""}ws-opts:\n    path: "/?ed=2560"\n    headers:\n      Host: ${cfg.host}`;
  }).join("\n\n");
  const names = Array.from({ length: 13 - start }, (_, n) => `    - "${cfg.country}-${n + start + 1}"`).join("\n");
  return `port: 7890\nallow-lan: true\nmode: rule\nlog-level: info\nproxies:\n${proxies}\n\nproxy-groups:\n- name: 自动选择\n  type: url-test\n  url: http://www.gstatic.com/generate_204\n  interval: 300\n  proxies:\n${names}\n- name: 🍭选择代理\n  type: select\n  proxies:\n    - 自动选择\n    - DIRECT\n${names}\nrules:\n  - GEOIP,LAN,DIRECT\n  - GEOIP,CN,DIRECT\n  - MATCH,🍭选择代理\n`;
}

function singboxConfig(cfg, tlsOnly) {
  const start = tlsOnly ? 7 : 0;
  const outbounds = Array.from({ length: 13 - start }, (_, n) => {
    const i = n + start, tag = `${cfg.country}-${i + 1}`;
    const outbound = { type: "vless", tag, server: cfg.ips[i], server_port: cfg.ports[i], uuid: cfg.uuid, packet_encoding: "packetaddr", transport: { type: "ws", path: "/?ed=2560", headers: { Host: [cfg.host] } } };
    if (i >= 7) outbound.tls = { enabled: true, server_name: cfg.host, utls: { enabled: true, fingerprint: "chrome" } };
    return outbound;
  });
  const tags = outbounds.map(o => o.tag);
  return JSON.stringify({ log: { level: "info" }, inbounds: [{ type: "tun", tag: "tun-in", address: ["172.19.0.1/30"], auto_route: true, strict_route: true, sniff: true }], outbounds: [{ type: "selector", tag: "select", outbounds: ["auto", ...tags] }, ...outbounds, { type: "direct", tag: "direct" }, { type: "urltest", tag: "auto", outbounds: tags, url: "https://www.gstatic.com/generate_204", interval: "1m" }], route: { auto_detect_interface: true, final: "select", rules: [{ inbound: "tun-in", action: "sniff" }, { protocol: "dns", action: "hijack-dns" }, { ip_is_private: true, outbound: "direct" }] } }, null, 2);
}

async function traffic(env, cfg) {
  let used = 0;
  if (env.D1) {
    try {
      await env.D1.prepare("CREATE TABLE IF NOT EXISTS traffic (uuid TEXT PRIMARY KEY, used_bytes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)").run();
      const row = await env.D1.prepare("SELECT used_bytes FROM traffic WHERE uuid = ?").bind(cfg.uuid).first();
      used = Number(row?.used_bytes || 0);
    } catch (error) { console.error("D1 read failed", error); }
  }
  const remain = Math.max(0, cfg.total * 1024 ** 3 - used) / 1024 ** 3;
  const expiry = Date.parse(`${cfg.expire}T23:59:59Z`);
  const days = Math.max(0, (Number.isFinite(expiry) ? expiry : Date.now()) - Date.now()) / 86400000;
  return `动态显示：${cfg.country}｜剩余${remain.toFixed(1)}g｜剩余${days.toFixed(1)}天`;
}

async function addTraffic(env, uuid, bytes) {
  if (!env.D1 || !bytes) return;
  try { await env.D1.prepare("INSERT INTO traffic (uuid, used_bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET used_bytes = traffic.used_bytes + excluded.used_bytes, updated_at = excluded.updated_at").bind(uuid, bytes, Date.now()).run(); }
  catch (error) { console.error("D1 write failed", error); }
}

function page(cfg, note) {
  const base = `https://${cfg.host}/${cfg.uuid}`;
  const links = cfg.host.includes("workers.dev") ? [{ label: "VLESS WS", value: vlessLine(cfg, 3, false) }, { label: "VLESS WS TLS", value: vlessLine(cfg, 7, true) }] : [{ label: "VLESS WS TLS", value: vlessLine(cfg, 7, true) }];
  const items = links.map(x => `<h3>${x.label}</h3><pre>${escapeHtml(x.value)}</pre>`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VLESS</title><style>body{font:16px system-ui;max-width:900px;margin:2rem auto;padding:0 1rem}pre{padding:1rem;background:#f3f3f3;overflow:auto}a{display:block;margin:.7rem 0}</style><h1>Cloudflare VLESS</h1><p>${escapeHtml(note)}</p>${items}<h2>订阅</h2><a href="${base}/ty">通用 VLESS 订阅</a><a href="${base}/cl">Clash-meta 订阅</a><a href="${base}/sb">Sing-box 订阅</a></html>`;
}

async function normalize(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Blob) return data.arrayBuffer();
  throw new TypeError("WebSocket frames must be binary");
}

function uuidString(bytes) {
  const h = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function parseVless(buffer, ids) {
  const b = new Uint8Array(buffer);
  if (b.length < 24) throw new Error("Invalid VLESS request");
  if (!ids.includes(uuidString(b.slice(1, 17)))) throw new Error("Invalid user");
  const opt = b[17], command = b[18 + opt];
  if (command !== 1 && command !== 2) throw new Error("Unsupported command");
  const portIndex = 19 + opt;
  const port = (b[portIndex] << 8) | b[portIndex + 1];
  const type = b[portIndex + 2];
  let index = portIndex + 3, address;
  if (type === 1) { if (b.length < index + 4) throw new Error("Invalid IPv4"); address = [...b.slice(index, index + 4)].join("."); index += 4; }
  else if (type === 2) { const len = b[index++]; if (b.length < index + len) throw new Error("Invalid domain"); address = new TextDecoder().decode(b.slice(index, index + len)); index += len; }
  else if (type === 3) { if (b.length < index + 16) throw new Error("Invalid IPv6"); address = Array.from({ length: 8 }, (_, i) => ((b[index + i * 2] << 8) | b[index + i * 2 + 1]).toString(16)).join(":"); index += 16; }
  else throw new Error("Unsupported address type");
  return { version: b.slice(0, 1), port, address, udp: command === 2, data: buffer.slice(index) };
}

function closeSocket(ws) { try { if (ws.readyState === OPEN) ws.close(); } catch {} }

async function proxy(request, env, cfg) {
  const pair = new WebSocketPair(), client = pair[0], server = pair[1];
  server.accept();
  let socket, bytes = 0, closed = false;
  const early = request.headers.get("Sec-WebSocket-Protocol") || "";
  const stream = new ReadableStream({ start(controller) {
    server.addEventListener("message", async e => { try { controller.enqueue(await normalize(e.data)); } catch (err) { controller.error(err); } });
    server.addEventListener("close", () => controller.close());
    if (early) { try { controller.enqueue(Uint8Array.from(atob(early.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)).buffer); } catch {} }
  }, cancel() { closeSocket(server); } });
  stream.pipeTo(new WritableStream({ async write(chunk) {
    if (!socket) {
      const parsed = parseVless(chunk, cfg.ids);
      if (parsed.udp) { if (parsed.port !== 53) throw new Error("Only DNS UDP is supported"); return dns(server, parsed.version, parsed.data); }
      socket = connect({ hostname: parsed.address, port: parsed.port });
      const writer = socket.writable.getWriter(); await writer.write(parsed.data); writer.releaseLock();
      socket.readable.pipeTo(new WritableStream({ write(data) { bytes += data.byteLength; if (server.readyState === OPEN) server.send(data); }, close() { closeSocket(server); } })).catch(() => closeSocket(server));
    } else { bytes += chunk.byteLength; const writer = socket.writable.getWriter(); await writer.write(chunk); writer.releaseLock(); }
  }})).catch(error => { console.error("proxy stream", error); closeSocket(server); }).finally(() => { if (!closed && bytes) { closed = true; ctxWait(env, cfg.uuid, bytes); } });
  return new Response(null, { status: 101, webSocket: client });
}

function ctxWait(env, uuid, bytes) { void addTraffic(env, uuid, bytes); }

async function dns(ws, version, data) {
  const b = new Uint8Array(data); let i = 0;
  while (i + 2 <= b.length) { const n = (b[i] << 8) | b[i + 1]; i += 2; const packet = b.slice(i, i + n); i += n; const response = await fetch(DNS_URL, { method: "POST", headers: { "content-type": "application/dns-message" }, body: packet }); const answer = new Uint8Array(await response.arrayBuffer()); const size = new Uint8Array([answer.length >> 8, answer.length & 255]); if (ws.readyState === OPEN) ws.send(new Blob([version, size, answer])); }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const cfg = getConfig(env, request), url = new URL(request.url);
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return proxy(request, env, cfg);
      const prefix = `/${cfg.uuid}`;
      if (url.pathname === prefix) return new Response(page(cfg, await traffic(env, cfg)), { headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-store" } });
      if (url.pathname === `${prefix}/ty`) return new Response(btoa(vlessList(cfg)), { headers: { "content-type": "text/plain;charset=UTF-8" } });
      if (url.pathname === `${prefix}/pty`) return new Response(btoa(vlessList(cfg, true)), { headers: { "content-type": "text/plain;charset=UTF-8" } });
      if (url.pathname === `${prefix}/cl`) return new Response(yamlConfig(cfg, false), { headers: { "content-type": "text/yaml;charset=UTF-8" } });
      if (url.pathname === `${prefix}/pcl`) return new Response(yamlConfig(cfg, true), { headers: { "content-type": "text/yaml;charset=UTF-8" } });
      if (url.pathname === `${prefix}/sb`) return new Response(singboxConfig(cfg, false), { headers: { "content-type": "application/json;charset=UTF-8" } });
      if (url.pathname === `${prefix}/psb`) return new Response(singboxConfig(cfg, true), { headers: { "content-type": "application/json;charset=UTF-8" } });
      return new Response(JSON.stringify({ ok: true, service: "cf-worker-quota", environment: env.ENVIRONMENT || "production" }), { headers: { "content-type": "application/json;charset=UTF-8", "cache-control": "no-store" } });
    } catch (error) {
      console.error("request failed", error);
      return new Response("Bad request", { status: 400, headers: { "content-type": "text/plain;charset=UTF-8", "cache-control": "no-store" } });
    }
  }
};
