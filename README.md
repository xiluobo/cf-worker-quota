# cf-worker-quota 改进版

本版基于你提供的 Worker 源码重构。保留 VLESS over WebSocket、13 组节点、六种订阅、国家标签、D1 历史流量；补全流量上限及到期控制。源码为单文件，可粘贴到 Cloudflare Worker 编辑器。

## 部署到现有 Worker

1. 先保存原 Worker 代码、环境变量及 D1 备份，以便回退。
2. 在现有 Worker 设置中确认数据库绑定名称为 **D1**，并指向原来的数据库。
3. 在该 D1 数据库控制台执行 `schema.sql`。它只在表不存在时建表，**不会清空或重置已有记录**。已有原版 `traffic` 表可直接沿用。
4. 设置下面的环境变量。必须将原来的 UUID 配置为 **UUID 密钥**；新源码没有硬编码账号。UUID 请使用小写并与原 `traffic.uuid` 记录一致，避免形成新的计费记录。
5. 用 `worker.js` 替换原代码，兼容性日期设为 `2026-09-30`。此 Worker 无第三方运行时依赖，不需要上传测试或安装包。
6. 发布后，用 Worker 的实际服务域名访问 `https://你的域名/你的UUID`。Cloudflare 管理控制台的 `dash.cloudflare.com` 地址不是订阅地址。
7. 更新客户端订阅，并先用小流量连接检查计费、DNS 和到期控制。

此交付没有修改或发布线上 Worker。真实出口连通性、Cloudflare 套餐限制及你的客户端版本仍需部署后验证。

## 环境变量

| 名称 | 必填 | 含义 / 默认值 |
|---|---|---|
| `UUID` | 是 | 单个 UUID v4；也兼容原来的小写变量名 `uuid`。两者同时存在时 `uuid` 优先。建议使用密钥类型。 |
| `D1` | 是 | 原 D1 数据库绑定；缺失或异常时拒绝代理请求，不会无计费放行。 |
| `COUNTRY` | 否 | 国家代码、中文名、国旗或组合，默认 `US`；只是显示标签，不选择出口地区。 |
| `TOTAL_TRAFFIC` | 否 | 总额度，单位 GiB（1024³ 字节），默认 `100`；允许小数，`0` 表示停用。 |
| `EXPIRE_DATE` | 否 | 默认 `2026-12-31`；纯日期表示该日 **UTC 23:59:59.999**。也支持带时区的 ISO 时间，如 `2026-12-31T23:59:59+08:00`。 |
| `proxyip` | 否 | 备用 TCP 地址，如 `example.com:443` 或 `[2001:db8::1]:443`。 |
| `cdnip` | 否 | 展示页单节点入口，默认沿用原脚本的 `www.visa.com.sg`。 |
| `ip1`…`ip13` | 否 | 各节点入口地址，沿用原脚本默认值；可以使用你验证过的域名或 IP。 |
| `pt1`…`pt13` | 否 | 对应端口。TLS 与节点槽位绑定：1–7 非 TLS，8–13 TLS；修改端口不会自动改变 TLS 类型。 |
| `TLS_ONLY` | 否 | `true` 时所有订阅仅生成 TLS 节点；默认 `false` 以保留原来的全部节点订阅。 |

默认入口仅沿用原配置，未测速或保证可达。不要把国家标签当成出口地区证据。

## 功能及访问路径

| 路径 | 功能 |
|---|---|
| `/UUID` | 节点与订阅展示页，显示额度、剩余流量、到期时间、状态；一键复制 |
| `/UUID/ty` | 通用 Base64 订阅，全部节点 |
| `/UUID/pty` | 通用 Base64 订阅，仅 TLS |
| `/UUID/cl` | Clash Meta / Mihomo 配置，全部节点 |
| `/UUID/pcl` | Clash Meta / Mihomo 配置，仅 TLS |
| `/UUID/sb` | Sing-box 配置，全部节点 |
| `/UUID/psb` | Sing-box 配置，仅 TLS |
| `/UUID/usage` | 使用量 JSON，字节总量与到期状态 |
| `/` 或 `/ws` + WebSocket Upgrade | 代理连接入口，使用协议内 UUID 验证；原 `/?ed=2560` 路径继续支持 |

普通根路径和未知路径返回 404，不再公开 `request.cf`。订阅链接包含连接凭据，请仅分享给允许使用该节点的人。

Clash 配置使用 JSON 表达（JSON 也是合法 YAML），保留自动选择、负载均衡、手动选择及国内直连。Sing-box 使用新 DNS 服务器格式及路由动作，面向 1.12+ 配置格式；原来的旧 DNS/FakeIP、旧入站 sniff 字段已移除。不同客户端集成版本可能有差异，应在客户端导入验证。自动测速会产生真实代理流量。

## 配额与计费口径

- 保留原表 `traffic(uuid, used_bytes, updated_at)`，继承已有 `used_bytes`。
- 每个上传或下载数据块在转发前执行一次 D1 条件写入；多个连接使用同一额度时，SQL 原子条件阻止累计值超过上限。
- 首包 TCP 有效载荷、后续上传、下载、DNS 查询与响应均计入。VLESS、WebSocket、TLS 和 DNS 长度前缀等协议开销不计入。
- 额度不足以容纳下一个完整数据块时，直接关闭连接；即使还剩少量字节，也不会发送半个块。
- 计费含义是 **已授权转发的有效载荷**，不是客户端最终确认收到的字节。数据库扣费后若网络写入失败、客户端断开、到期或数据库响应丢失，可能计入最终未送达的数据；不做不安全的自动重试或退款，避免重复写入或突破额度。
- 数据库缺失、表未初始化、数据库故障、无效配置都会拒绝服务；错误细节和密钥不返回给客户端。
- 不再依赖连接关闭后才保存流量，因此长连接也持续扣减。
- 到期会拒绝新连接，并通过定时器及每次转发前检查关闭已有连接。修改环境变量后，已建立的旧连接仍使用建连时的配置，断开重连后才应用新配置。
- 订阅响应提供 `Subscription-Userinfo`，客户端是否显示取决于其实现。旧表没有上传/下载拆分，因此将合计放在 `download`、`upload=0`；不应把它解读为纯下载流量。

### 性能边界

这是一版优先保障配额一致性的 **D1 严格计费方案**。每个有效载荷块（最多 64 KiB）都会产生一次 D1 操作；小帧、并发连接和自动测速也会增加查询次数。相比原版断开后写一次，它会增加数据库开销与延迟，受 Worker 子请求和 D1 额度限制，**不能将它视为无限流量或高吞吐方案**。适合先以小流量验证；高吞吐场景应进一步使用 Durable Objects 统一管理额度和连接，而不是降低扣费频率后宣称仍可严格限额。

## 连接与兼容性改动

- 配置全部按请求隔离，消除模块级用户、D1、ProxyIP 等变量串用。
- 支持分片 VLESS 头、分片 DNS 数据报、WebSocket early data；明确拒绝非二进制帧及不支持的命令。
- UDP 仅支持 DNS 53；生成的客户端配置不提供通用 UDP 代理。
- 首次 TCP 建连失败时可尝试配置的 ProxyIP；**不会因为暂无下行数据而重放已经发出的应用请求**，避免重复提交。
- 移除 URL 中任意 `/pyip=` 覆盖，备用地址统一由环境变量管理。
- 移除原版 IPv4 到 `sslip.io` 域名的隐式改写，直接传递目标地址给 sockets API。Cloudflare 平台不允许的目标仍会被平台拒绝。
- 上行排队上限 2 MiB；单次建连和 DoH 请求超时 10 秒；连接空闲 120 秒后关闭。
- 界面无外部 JS/CSS 依赖，转义动态文本，添加 CSP、防嵌入、禁缓存和不发送 Referer 的响应头。
- 保留单 UUID 模型，没有添加充值、后台账号、多用户套餐或公网管理接口。

## GitHub Actions 部署准备

已提供 `.github/workflows/deploy.yml`，支持 main 分支推送后自动执行，也支持手动触发。实际结果以 GitHub Actions 为准。

在目标仓库配置：

- Actions secret：`CLOUDFLARE_API_TOKEN`，限定到目标账号，具备 Workers Scripts 编辑和 D1 编辑权限。
- Actions variable：`CLOUDFLARE_ACCOUNT_ID`，填写现有 Worker 的账号 ID。
- 现有 Worker 必须已绑定 `D1` 并配置原 `UUID`（或 `uuid`）。

工作流读取现有 Worker 设置，生成忽略提交的 `.deploy/wrangler.jsonc`；发现其他未知绑定会中止，避免意外移除资源绑定。保留数据库 ID 和控制台变量，不自动创建替代数据库。然后运行测试、类型检查、dry run、无损建表和部署。成功部署仍需对实际服务域名做客户端验收。

## 本地验证命令

需要 Node.js 24；测试依赖已固定版本，不参与线上运行。

```text
npm install
npm test
npm run check
```

`tests/worker.test.mjs` 使用真实 SQLite 执行计费 SQL，并模拟 sockets/WebSocket 验证连接生命周期。
`tests/runtime.test.mjs` 使用 Miniflare/workerd 验证真实 Workers 运行时、D1 绑定、六种订阅和 WebSocket 鉴权。
类型检查启用 checkJs，以 Cloudflare Workers 类型验证 API；它不是完整 strict TypeScript 审计。

测试没有向你的 Cloudflare 账号写入任何数据，也不能替代真实客户端与出口网络的验收。

## 核对参考

- [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [TCP sockets API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [D1 Prepared Statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [D1 Sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Sing-box 配置迁移](https://sing-box.sagernet.org/migration/)
