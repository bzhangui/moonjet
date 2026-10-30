# 协议、预算与恢复

0.2.0 新增有界 PullWorker、MoonBit DeliveryPolicy、脱敏 stats 和 SQLite 事务幂等示例，完整参数/失败处置见 [WORKER](WORKER.md)。工作器成功后双 ACK，失败有界延迟；超时/投递耗尽停止且不自动 TERM，旧连接投递禁止确认。不忽略处理函数尚未退出的事实，不宣称跨库或外部副作用恰好一次。

核心可四目标复用，app 桥与 platform/client.mjs 为当前联网实现。支持 INFO/PING/PONG/+OK/-ERR/MSG/HMSG 与 PUB/HPUB/SUB/UNSUB，二进制和重复头部。

控制文本4096、头部8192字节/64项；SDK发布消息1 MiB含头部，RPC/flush各32，默认待写socket2 MiB，pull最多256、累计返回8 MiB。API JSON2 MiB/24层，适配接收帧2 MiB，为历史回读的Base64膨胀留余量；历史业务数据仍最多1 MiB。CORE codec硬上限8 MiB，单次feed最多1 MiB，可分块。超过预算拒绝。

流默认 file/limits、最多100000消息/16 MiB、去重120秒。消费者 explicit ACK、等待30秒、max_ack_pending32、max_deliver5。未知options拒绝；序号规范十进制字符串保留uint64，wire时间为纳秒数字而非Int64 JSON字符串。

publish提供稳定messageId，同事件重试不变，不同事件不得共用。ack等待服务端确认；nak延迟、working延时、term终止重投。无响应/API错误/超时/断线拒绝，不返回假成功。

突停可能保留消息但已确认工作仍重投，业务须幂等/事务去重。断线先恢复、再同ID重试；超去重窗口仍靠业务识别。0.3.0 支持可信种子/发现池有界退避和订阅重建，无无限队列，无不确定发布自动重发。

0.3.0 新增集群切换/发现、JWT/NKey/credentials、Push、KV/Object Store、TLS-first/mTLS，接口与限制见 [SDK_GUIDE](SDK_GUIDE.md)、[COMPATIBILITY](COMPATIBILITY.md)。已做同机三节点节点突停/多数派丢失受控验证，但不提供 Native/Wasm socket、WebSocket；真实断电、跨主机网络分区、长期生产和外部用户未验证。

install-server 下载固定官方程序；demo 自建随机回环端口/临时仓库，只清理自建数据和进程。validate 包含真实服务/TLS、错误凭据/证书/明文拒绝及错误对端。无服务/OpenSSL就失败不静默跳过。排查版本、构建、CA/主机名、账号权限、JetStream启用、配额、命名、超时/ACK策略。

0.1.1 拒绝未知请求/发布/拉取选项，pull必须布尔，非pull请求只允许一个回复，NAK延迟必须0..3600000的整数。握手需要header能力；JSON严格UTF-8，历史回复序号与Base64严格检查。用户应升级，不依赖旧版对畸形配置/控制字段的宽松行为。
