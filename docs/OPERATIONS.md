# 协议、预算与恢复

核心可四目标复用，app 桥与 platform/client.mjs 为当前联网实现。支持 INFO/PING/PONG/+OK/-ERR/MSG/HMSG 与 PUB/HPUB/SUB/UNSUB，二进制和重复头部。

控制文本4096、头部8192字节/64项；SDK消息1 MiB含头部，RPC/flush各32，默认待写socket2 MiB，pull最多256、累计返回8 MiB。API JSON1 MiB/24层；CORE codec硬上限8 MiB，可降低。超过预算拒绝。

流默认 file/limits、最多100000消息/16 MiB、去重120秒。消费者 explicit ACK、等待30秒、max_ack_pending32、max_deliver5。未知options拒绝；序号规范十进制字符串保留uint64，wire时间为纳秒数字而非Int64 JSON字符串。

publish提供稳定messageId，同事件重试不变，不同事件不得共用。ack等待服务端确认；nak延迟、working延时、term终止重投。无响应/API错误/超时/断线拒绝，不返回假成功。

突停可能保留消息但已确认工作仍重投，业务须幂等/事务去重。断线先恢复、再同ID重试；超去重窗口仍靠业务识别。原端点有界指数退避，无无限队列，无不确定发布自动重发。

不支持集群切换/发现、JWT/NKey、push、KV/Object Store、WebSocket、handshake-first；不提供Native/Wasm socket。真实断电、集群、长期生产和外部用户未验证。

install-server 下载固定官方程序；demo 自建随机回环端口/临时仓库，只清理自建数据和进程。validate 包含真实服务/TLS、错误凭据/证书/明文拒绝及错误对端。无服务/OpenSSL就失败不静默跳过。排查版本、构建、CA/主机名、账号权限、JetStream启用、配额、命名、超时/ACK策略。
