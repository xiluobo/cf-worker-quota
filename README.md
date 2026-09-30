# cf-worker-quota

这是一个可直接部署到 Cloudflare Workers 的最小化代理订阅 Worker，适合：

- 托管 VLESS 订阅链接
- 提供 Clash Meta / Sing-box / 通用订阅文件
- 通过环境变量控制 UUID、国家、流量和过期时间
- 可选接入 Cloudflare D1 做流量统计

## 安装与部署

```bash
npm install
npx wrangler login
npm run deploy
```

## 访问方式

部署后，默认访问：

```text
https://<your-worker>.workers.dev/
https://<your-worker>.workers.dev/<UUID>
https://<your-worker>.workers.dev/<UUID>/ty
https://<your-worker>.workers.dev/<UUID>/cl
https://<your-worker>.workers.dev/<UUID>/sb
```

## 配置变量

在 Cloudflare Dashboard 中设置环境变量，或在 `wrangler.toml` 中直接声明：

```toml
[vars]
UUID = "86c50e3a-5b87-49dd-bd20-03c7f2735e40"
COUNTRY = "US"
TOTAL_TRAFFIC = "100"
EXPIRE_DATE = "2026-12-31"
```

生产环境建议用 `wrangler secret put UUID` 保护真实 UUID，而不是把它直接提交到仓库。

## D1（可选）

如果你启用 D1 绑定，Worker 会自动在 `traffic` 表中记录用量。配置示例：

```toml
[[d1_databases]]
binding = "D1"
database_name = "cf-worker-quota"
database_id = "<your-database-id>"
```

## 本地开发

```bash
npm run dev
```

## 注意事项

- 这是网络代理脚本，请务必遵守当地法律法规和 Cloudflare 服务条款。
- 密钥和真实 UUID 请勿泄露给未授权用户。
