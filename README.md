# cf-worker-quota

这是一个 Cloudflare Worker VLESS over WebSocket 服务，提供：

- UUID 鉴权的 VLESS WebSocket TCP 代理
- 仅用于 DNS 的 UDP over DoH
- VLESS、Clash Meta、Sing-box 订阅
- 可选 Cloudflare D1 流量统计与剩余流量显示
- 环境变量配置与请求输入校验

## 部署

```bash
npm install
npx wrangler login
npm run deploy
```

部署后访问：

```text
https://<worker-domain>/<UUID>
```

订阅端点：`/UUID/ty`、`/UUID/pty`、`/UUID/cl`、`/UUID/pcl`、`/UUID/sb`、`/UUID/psb`。

## 配置

请在 `wrangler.toml` 或 Cloudflare Dashboard 的 Variables 中配置 `UUID`、`COUNTRY`、`TOTAL_TRAFFIC` 和 `EXPIRE_DATE`。生产环境建议使用 Secret 设置 UUID，而不是把真实 UUID 提交到仓库：

```bash
npx wrangler secret put UUID
```

`UUID` 支持逗号分隔的多个 UUID。可用 `IP1`–`IP13`、`PT1`–`PT13` 覆盖节点地址和端口，`cdnip` 覆盖首页展示地址。

## D1 流量统计（可选）

创建数据库并将生成的 `database_id` 写入 `wrangler.toml`，启用 `D1` binding 后 Worker 会自动创建 `traffic` 表并在连接结束时累计流量。也可以提前执行：

```sql
CREATE TABLE IF NOT EXISTS traffic (
  uuid TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

## 本地开发

```bash
npm run dev
```

注意：这是网络代理 Worker，请只为自己控制的客户端和网络使用，并妥善保护 UUID。
