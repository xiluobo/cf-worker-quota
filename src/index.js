export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const cfg = buildConfig(env, request);

      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return handleWebSocket(request, env, cfg);
      }

      if (url.pathname === "/") {
        return jsonResponse({
          ok: true,
          service: "cf-worker-quota",
          environment: env.ENVIRONMENT || "production",
          timestamp: new Date().toISOString(),
          uuid: cfg.uuid,
          country: cfg.country,
          remaining: cfg.displayText,
        });
      }

      if (url.pathname === `/${cfg.uuid}`) {
        return htmlResponse(renderHome(cfg));
      }

      if (url.pathname === `/${cfg.uuid}/ty`) {
        return textResponse(buildVlessList(cfg, false), "text/plain;charset=UTF-8");
      }

      if (url.pathname === `/${cfg.uuid}/pty`) {
        return textResponse(buildVlessList(cfg, true), "text/plain;charset=UTF-8");
      }

      if (url.pathname === `/${cfg.uuid}/cl`) {
        return textResponse(buildClashConfig(cfg, false), "text/yaml;charset=UTF-8");
      }

      if (url.pathname === `/${cfg.uuid}/pcl`) {
        return textResponse(buildClashConfig(cfg, true), "text/yaml;charset=UTF-8");
      }

      if (url.pathname === `/${cfg.uuid}/sb`) {
        return textResponse(buildSingboxConfig(cfg, false), "application/json;charset=UTF-8");
      }

      if (url.pathname === `/${cfg.uuid}/psb`) {
        return textResponse(buildSingboxConfig(cfg, true), "application/json;charset=UTF-8");
      }

      return jsonResponse({ ok: true, service: "cf-worker-quota", path: url.pathname }, 200, { "cache-control": "no-store" });
    } catch (error) {
      console.error("worker_error", error);
      return jsonResponse({ ok: false, error: "Bad request" }, 400, { "cache-control": "no-store" });
    }
  },
};

function buildConfig(env, request) {
  const uuid = normalizeUuid(env.UUID || env.uuid || "86c50e3a-5b87-49dd-bd20-03c7f2735e40");
  const country = normalizeCountry(env.COUNTRY || "US");
  const totalTrafficGB = Number(env.TOTAL_TRAFFIC || 100);
  const expireDate = String(env.EXPIRE_DATE || "2026-12-31");
  const host = request.headers.get("Host") || new URL(request.url).host;
  const ips = [
    env.ip1 || "www.visa.com",
    env.ip2 || "cis.visa.com",
    env.ip3 || "africa.visa.com",
    env.ip4 || "www.visa.com.sg",
    env.ip5 || "www.visaeurope.at",
    env.ip6 || "www.visa.com.mt",
    env.ip7 || "qa.visamiddleeast.com",
    env.ip8 || "usa.visa.com",
    env.ip9 || "myanmar.visa.com",
    env.ip10 || "www.visa.com.tw",
    env.ip11 || "www.visaeurope.ch",
    env.ip12 || "www.visa.com.br",
    env.ip13 || "www.visasoutheasteurope.com",
  ];
  const ports = [
    Number(env.pt1 || 80),
    Number(env.pt2 || 8080),
    Number(env.pt3 || 8880),
    Number(env.pt4 || 2052),
    Number(env.pt5 || 2082),
    Number(env.pt6 || 2086),
    Number(env.pt7 || 2095),
    Number(env.pt8 || 443),
    Number(env.pt9 || 8443),
    Number(env.pt10 || 2053),
    Number(env.pt11 || 2083),
    Number(env.pt12 || 2087),
    Number(env.pt13 || 2096),
  ];

  const remain = calculateRemainingGB(totalTrafficGB, env.D1, uuid);
  const days = calculateRemainingDays(expireDate);

  return {
    uuid,
    country,
    totalTrafficGB: Number.isFinite(totalTrafficGB) ? totalTrafficGB : 100,
    expireDate,
    host,
    ips,
    ports,
    displayText: `${country}｜剩余${remain.toFixed(1)}GB｜剩余${days.toFixed(1)}天`,
    cdnip: env.cdnip || "www.visa.com",
  };
}

function normalizeUuid(value) {
  const raw = String(value || "").trim();
  const list = raw.split(",").map(v => v.trim()).filter(Boolean);
  if (!list.length) throw new Error("UUID is required");
  if (!list.every(v => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))) {
    throw new Error("UUID format is invalid");
  }
  return list[0];
}

function normalizeCountry(value) {
  const raw = String(value || "US").trim();
  if (!raw) return "美国";
  const codeMap = {
    US: "美国", CN: "中国", HK: "香港", TW: "台湾", JP: "日本", KR: "韩国",
    SG: "新加坡", GB: "英国", DE: "德国", FR: "法国", IT: "意大利", ES: "西班牙",
    PT: "葡萄牙", NL: "荷兰", CH: "瑞士", AT: "奥地利", RU: "俄罗斯", BR: "巴西",
    CA: "加拿大", AU: "澳大利亚", NZ: "新西兰", IN: "印度", TH: "泰国",
  };
  const upper = raw.toUpperCase();
  if (codeMap[upper]) return codeMap[upper];
  return raw;
}

async function calculateRemainingGB(totalGb, d1, uuid) {
  if (!d1) return Math.max(0, totalGb);
  try {
    await d1.prepare("CREATE TABLE IF NOT EXISTS traffic (uuid TEXT PRIMARY KEY, used_bytes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)").run();
    const row = await d1.prepare("SELECT used_bytes FROM traffic WHERE uuid = ?").bind(uuid).first();
    const used = Number(row?.used_bytes || 0);
    return Math.max(0, totalGb - used / (1024 * 1024 * 1024));
  } catch (error) {
    console.error("D1 read failed", error);
    return Math.max(0, totalGb);
  }
}

function calculateRemainingDays(expireDate) {
  const parsed = Date.parse(`${expireDate}T23:59:59Z`);
  if (!Number.isFinite(parsed)) return 30;
  const diffMs = parsed - Date.now();
  return Math.max(0, diffMs / 86400000);
}

function buildVlessList(cfg, tlsOnly) {
  const start = tlsOnly ? 7 : 0;
  const lines = [];
  for (let i = start; i < 13; i++) {
    const isTls = i >= 7;
    const host = cfg.host;
    const ip = cfg.ips[i];
    const port = cfg.ports[i];
    const query = new URLSearchParams({
      encryption: "none",
      security: isTls ? "tls" : "none",
      fp: "randomized",
      type: "ws",
      host,
      path: "/?ed=2560",
    });
    if (isTls) query.set("sni", host);
    const url = `vless://${cfg.uuid}@${ip}:${port}?${query.toString()}#${cfg.country}-${i + 1}`;
    lines.push(url);
  }
  return lines.join("\n");
}

function buildClashConfig(cfg, tlsOnly) {
  const start = tlsOnly ? 7 : 0;
  const proxies = [];
  const names = [];
  for (let i = start; i < 13; i++) {
    const isTls = i >= 7;
    const name = `${cfg.country}-${i + 1}`;
    const ip = cfg.ips[i];
    const port = cfg.ports[i];
    names.push(`    - "${name}"`);
    const block = [
      `- name: "${name}"`,
      "  type: vless",
      `  server: ${ip}`,
      `  port: ${port}`,
      `  uuid: ${cfg.uuid}`,
      "  udp: false",
      `  tls: ${isTls ? "true" : "false"}`,
      "  network: ws",
      ...(isTls ? [`  servername: ${cfg.host}`] : []),
      "  ws-opts:",
      '    path: "/?ed=2560"',
      "    headers:",
      `      Host: ${cfg.host}`,
    ].join("\n");
    proxies.push(block);
  }

  return [
    "port: 7890",
    "allow-lan: true",
    "mode: rule",
    "log-level: info",
    "proxies:",
    proxies.join("\n\n"),
    "",
    "proxy-groups:",
    "- name: 自动选择",
    "  type: url-test",
    "  url: http://www.gstatic.com/generate_204",
    "  interval: 300",
    "  proxies:",
    names.join("\n"),
    "- name: 🍭选择代理",
    "  type: select",
    "  proxies:",
    "    - 自动选择",
    "    - DIRECT",
    names.join("\n"),
    "",
    "rules:",
    "  - GEOIP,LAN,DIRECT",
    "  - GEOIP,CN,DIRECT",
    "  - MATCH,🍭选择代理",
  ].join("\n");
}

function buildSingboxConfig(cfg, tlsOnly) {
  const start = tlsOnly ? 7 : 0;
  const tags = [];
  const outbounds = [];
  for (let i = start; i < 13; i++) {
    const tag = `${cfg.country}-${i + 1}`;
    tags.push(tag);
    const item = {
      type: "vless",
      tag,
      server: cfg.ips[i],
      server_port: cfg.ports[i],
      uuid: cfg.uuid,
      transport: {
        type: "ws",
        path: "/?ed=2560",
        headers: { Host: [cfg.host] },
      },
    };
    if (i >= 7) {
      item.tls = { enabled: true, server_name: cfg.host, utls: { enabled: true, fingerprint: "chrome" } };
    }
    outbounds.push(item);
  }

  return JSON.stringify({
    log: { level: "info" },
    inbounds: [{
      type: "tun",
      tag: "tun-in",
      address: ["172.19.0.1/30", "fd00::1/126"],
      auto_route: true,
      strict_route: true,
      sniff: true,
      sniff_override_destination: true,
    }],
    outbounds: [
      { type: "selector", tag: "select", default: "auto", outbounds: ["auto", ...tags] },
      ...outbounds,
      { type: "direct", tag: "direct" },
      { type: "urltest", tag: "auto", outbounds: tags, url: "https://www.gstatic.com/generate_204", interval: "1m" },
    ],
    route: {
      auto_detect_interface: true,
      final: "select",
      rules: [{ protocol: "dns", action: "hijack-dns" }, { ip_is_private: true, outbound: "direct" }],
    },
  }, null, 2);
}

function renderHome(cfg) {
  const links = [
    { label: "VLESS WS", href: `vless://${cfg.uuid}@${cfg.cdnip}:8880?encryption=none&security=none&type=ws&host=${encodeURIComponent(cfg.host)}&path=%2F%3Fed%3D2560#${encodeURIComponent(cfg.country)}` },
    { label: "VLESS WS TLS", href: `vless://${cfg.uuid}@${cfg.cdnip}:8443?encryption=none&security=tls&type=ws&host=${encodeURIComponent(cfg.host)}&sni=${encodeURIComponent(cfg.host)}&fp=randomized&path=%2F%3Fed%3D2560#${encodeURIComponent(cfg.country)}` },
  ];

  const linkHtml = links.map(item => `
    <div class="card">
      <h3>${escapeHtml(item.label)}</h3>
      <p>${escapeHtml(item.href)}</p>
      <button onclick="navigator.clipboard.writeText(${JSON.stringify(item.href)})">复制</button>
    </div>
  `).join("");

  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Cloudflare Worker Quota</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; max-width: 980px; margin: 40px auto; padding: 0 20px; }
        .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin: 20px 0; }
        p { word-break: break-all; }
        button { background: #2563eb; color: white; border: none; border-radius: 8px; padding: 10px 14px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Cloudflare Worker Quota</h1>
      <p>${escapeHtml(cfg.displayText)}</p>
      <div>${linkHtml}</div>
      <p><a href="/${cfg.uuid}/ty">通用订阅</a></p>
      <p><a href="/${cfg.uuid}/cl">Clash Meta</a></p>
      <p><a href="/${cfg.uuid}/sb">Sing-box</a></p>
    </body>
  </html>`;
}

function handleWebSocket(request, env, cfg) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  server.addEventListener("message", event => {
    const raw = event.data;
    const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
    if (server.readyState === 1) {
      server.send(bytes);
    }
  });

  server.addEventListener("close", () => {
    try { server.close(); } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8", ...extraHeaders },
  });
}

function textResponse(content, contentType) {
  return new Response(content, { headers: { "content-type": contentType, "cache-control": "no-store" } });
}

function htmlResponse(content) {
  return new Response(content, { headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-store" } });
}
