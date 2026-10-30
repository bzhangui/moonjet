# 更新记录

## 0.3.0 — 2026-10-30（源码升级，暂不发布 Mooncakes）

- 新增 MoonBit StreamConfig/ConsumerConfig、管理请求目录，保留 2.15.1 全部 38/35 项顶层配置与精确整数；完整 CRUD、分页、暂停/恢复、快照/恢复、领导者切换和副本管理请求。嵌套和跨字段语义仍由服务端验证。
- Push/队列组、AckNone/AckAll/显式 ACK、流控与心跳、有界订阅、保留缓存 drain，持久 Pull/工作器继续可用；跨代次投递确认隔离。
- 可信种子池/INFO 发现、无 TLS 降级的重连、订阅重建与新认证回调；MoonBit NKey 编码/CRC，Node Ed25519；JWT/credentials/TLS-first/mTLS 实际回归。
- KV CAS、历史、TTL、删除/清除/重建、keys/watch；Object Store 流式分块、SHA-256、元数据 CAS、链接、watch、seal 与显式静默维护 GC。存储/监听一致性和旧块保留边界写明，不冒称生产恰好一次。
- 增加 nats.js/nats.go 官方客户端双向互操作、真实三节点突停/失去多数派/恢复、快照消费者状态恢复、错误凭据/过期 JWT、摘要破坏、取消、预算和清理回归。
- 最低 moonc 调整为 0.10.18，本机测试 0.10.18；CI 安装锁定的开发对照依赖与 Go。运行适配无官方客户端依赖，运行包/注册表逐文件白名单扩展，私有资料不公开。
- README、SDK 使用指南、兼容矩阵、验收/质量记录与本地申报书示例同步；本轮只提交并推送 GitHub，不发布 Mooncakes 或公开运行包。远端 CI 与本机结果分开记载。

## 0.2.1 — 2026-10-27

- 修复高层管理请求和发布确认的 JetStream API 错误漏记；UTF-8/JSON/PubAck、历史回读及拉取身份校验失败也纳入统计，不重复记交换错误。
- `requestFailures` 改为失败总数，新增 `exchangeFailures` / `apiErrors` / `responseFailures`。原字段保留但口径扩展，告警阈值需复核；预检拒绝和底层 request 的业务解释边界明确。
- 提供 `npm run toolchain -- --check` 和 `--moon <绝对路径>`，私有配置选中已安装 SDK，自动匹配 SDK 根目录，拒绝过旧/无效配置，不改变全局 SDK 或复制凭据。修正版本比较对未来补丁号的兼容性。
- 新增 14 项 Node 回归（69 项总数）：错误计数、失败分类/去重、畸形回复、超时、工具链配置、真实账号密码鉴权和注册表文件白名单；TLS 回归同时验证账号密码接入。
- 发布采用逐文件 `.moonignore` 白名单，私人申报书、凭据、本机配置及未列出的运行数据默认排除。实际归档还须核对条目、字节和许可证，不只依赖忽略规则。
- 本轮已推送 GitHub 并正式发布 Mooncakes 0.2.1，新三平台源码 CI、匿名构建/校验和及独立四目标安装验证通过，证据见 PUBLICATION。不上传桌面运行包；MoonBit 公共 API、Apache-2.0/NOTICE 和旧快照不变。

## 0.2.0 — 2026-10-22

- 发布前扩展复测发现并修复字节预算结束的部分批次误丢弃：409 Batch Completed正常结束；Message Size Exceeds MaxBytes仅在已有消息时返回部分批次，首条超限及消费者删除等其他409仍失败。Frame新增description，直接构造结构体的消费者需适配；pull_status供四目标复用。
- 工作器拉取等待封顶AckWait/3，避免短ACK等待、批次未满时阻塞处理；数据库示例close幂等。

- MoonBit DeliveryPolicy：精确 uint64 投递次数、指数延迟 NAK、有限重试和停止决策，核心四目标复用。
- PullWorker：1..16 并发、无预取队列、配置预检、成功双 ACK、working 心跳、优雅停机、超时/断线隔离与处理静止查询。
- Client/worker 脱敏冻结指标；NAK/TERM 后禁止重复结算，旧连接投递禁止确认；拉取核对流/消费者身份。
- SQLite inbox 示例：业务键与更新同库事务，提交后未 ACK 重投、不同 transport ID 同业务键和回滚；不宣称跨系统恰好一次。
- Node 最低22.13（内置 SQLite 示例），运行包包含工作器/新样例；CI actions更新固定SHA，凭据不持久化。

## 0.1.1 — 2026-10-13

- 非法 NAK 延迟不再退化为立即重投；请求/发布/拉取未知选项与非布尔 pull 明确拒绝。
- 拒绝畸形头部、控制字符、提前终止及无效状态；连接时验证头部能力，远程用户名也受明文鉴权门禁保护。
- 修复接近 1 MiB 发布消息无法历史读取的问题：管理 JSON/适配接收帧最多 2 MiB，业务数据仍最多 1 MiB。
- 历史回复核对序号并严格校验 Base64；JSON 控制回复严格 UTF-8 解码，不用替换字符掩盖坏数据。
- 增加乱序相关、断线不确定结果清理及真实 900000 字节数据回读回归；版本标识同步各交付入口。

## 0.1.0 — 2026-10-13

- 独立NATS二进制codec、JetStream、ACK/uint64。
- TCP/证书TLS、稳定ID、durable pull/重投/回放。
- 有界RPC/flush/socket、原端点重连、不确定结果处理。
- 真实服务/鉴权/证书/重启、错误对端、四目标、CI。
- 联网仅Node/JS；保留断电/集群/生产/外部缺口。
