# MoonJet 0.3.0 兼容范围与证据

本轮针对 Push、管理、集群、认证、KV 和 Object Store 六类缺口扩展。以下是**版本限定的能力声明**，不是 nats.go/nats.js 完全等价、官方认证或所有配置组合均已验证的声明。

| 能力 | 已实现接口 | 直接证据与边界 |
| --- | --- | --- |
| 流管理 | 创建、更新、信息、分页列表/名称、删除、清除、历史消息选择/删除、快照/恢复、领导者切换、移除副本、取消迁移 | 核心请求构造；真实服务 CRUD、快照数据/消费者状态恢复；三节点领导者切换。副本移除/取消迁移只有请求路由测试，未执行破坏性集群拓扑变更 |
| 消费者管理 | 持久/临时创建与更新、绑定、信息、删除、分页、暂停/恢复、领导者切换请求 | 真实服务 CRUD/暂停/恢复/队列组；消费者领导者切换仅路由测试 |
| 配置 | NATS Server 2.15.1 的 StreamConfig 38 个、ConsumerConfig 35 个顶层字段；精确整数、未知字段拒绝、嵌套配置原样保留 | 核心目录和类型测试；嵌套字段语义、不可变条件和跨字段组合最终由对应版本服务端验证，不宣称本地复制了全部服务端校验器 |
| 消费 | Durable Pull、显式 ACK/NAK/working/TERM、Push、队列组、AckNone/AckAll/显式 ACK、有界订阅、心跳和流控、保留接收队列的 drain | 单节点真实二进制、确认策略、队列分配和慢消费拒绝；三节点 Push 断线恢复；不提供自动修复的 ordered-consumer 专用抽象 |
| 集群 | 多 seed、可信主机发现、TLS 不降级、有界重连、订阅重建、旧代次确认隔离 | 同机三进程 R3 流、节点突停、重投、失去多数派不伪造 PubAck、节点重启恢复。不是独立主机网络分区/真实断电/长期压测 |
| 认证 | Token、user/password、NKey、JWT、credentials 文件/回调；每次重连重读；证书 TLS、TLS-first、mTLS | 实际 NKey/operator JWT 服务；错误身份/过期 JWT 拒绝；临时合成身份轮换；自建证书 mTLS/TLS-first 正反例。不代办账号签发、吊销或外部身份系统 |
| KV | 创建/打开、put/get/指定 revision、CAS create/update、删除/清除、历史、keys、初始化+实时 watch、状态、配置、销毁 | 真实服务二进制/CAS/TTL/删除重建/清除/watch/清理；nats.js 和 nats.go 双向互通。专用 KV 暂不自动路由镜像/source 的写入到源桶，此类需求用显式源桶与管理 API，不静默猜测 |
| Object Store | 分块上传、流式下载、SHA-256 完整性、空对象、元数据更新、删除、对象/桶链接、列表/watch、seal、状态、销毁、只读垃圾审计和显式静默期回收 | 自建服务多分块/中文名称/摘要破坏/取消/预算/CAS/清理；两种官方客户端双向读写。摘要仅在完整读到 EOF 后验证；覆盖保留旧代数据，GC 必须无在途读写，不提供跨客户端自动锁 |

## 官方客户端对照方法

测试固定 nats.js 3.4.0（transport-node/jetstream/kv/obj）、nkeys 2.0.3，nats.go 1.55.0、jwt 2.8.2，真实 NATS Server 2.15.1。依赖只用于 `tests/`，生产 `platform/` 不导入官方 SDK，运行包也不携带这些开发依赖。Go 参考程序生成的临时种子和 JWT 只在测试进程内传递，不写进仓库或输出日志。

双向对照包括原始二进制消息、Push 接收和确认、KV revision/CAS/墓碑、跨客户端多分块对象。没有将函数同名、字段存在或单一示例成功等同于全部官方测试套件通过。

## 版本与平台

要求 moonc ≥0.10.18；本轮本机实际使用 0.10.18，核心检查/构建/用例/样例运行在 JS、Wasm、Wasm-GC、Native。网络、TLS、Ed25519、SHA-256、流式调度由 Node ≥22.13 参考适配提供；四目标核心通过**不代表** Native/Wasm 已具备网络适配。SQLite 幂等示例是独立业务演示，不属于协议依赖。

## 保留缺口

WebSocket、原生 MoonBit TCP/TLS、跨账户/跨集群路由整体验证、服务商实际账号、长时间生产试点、独立机器分区与断电仍待授权环境验证。源/镜像配置可通过管理 API 发送，但专用 KV 自动源路由、Object Store 跨副本延迟一致性没有实测承诺。所有模拟/受控演练都明确标注，不能代替上述证据。

## 参考与许可证

许可说明：下文的 Apache-2.0 指直接 NATS 对照项目；传递开发依赖还包括 MIT（js-sha256）、Unlicense（tweetnacl）、BSD-3-Clause（Go compress、golang.org/x 等）。各依赖保留各自许可，不随生产运行包携带，不重新许可为本项目许可。

独立实现协议和状态规则，未复制官方 SDK 实现。参考 [NATS 协议](https://docs.nats.io/reference/protocols/client/)、[JetStream API](https://docs.nats.io/reference/jetstream/api/)、[Object Store ADR-20](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-20.md)。对照项目：[nats.js](https://github.com/nats-io/nats.js)、[nats.go](https://github.com/nats-io/nats.go)、[jwt](https://github.com/nats-io/jwt)。上述开发依赖使用 Apache-2.0，上游许可证保留在 npm 包/Go 模块中；本项目 [Apache-2.0](../LICENSE)、[NOTICE](../NOTICE) 和标准库许可证持续保留。
