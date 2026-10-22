# 有界消费与业务幂等

先按 README 构建，在自有且获授权的 JetStream 服务创建 file/limits 流和 durable explicit-ACK pull 消费者。

```js
import {Client} from '../platform/client.mjs';
import {PullWorker} from '../platform/worker.mjs';
const client = await Client.connect('nats://127.0.0.1:4222');
const worker = new PullWorker(client, 'ORDERS', 'WORKER', async (message) => {
  // 业务自行实现：在同一数据库事务内更新业务和 eventId 去重记录。
  await processInYourTransaction(message.data, message.signal);
}, {concurrency: 4, maxMessages: 1000});
const done = worker.run(); // 必须保留并等待，失败会拒绝。
// 停机时 await worker.stop()，不再拉新消息，允许在途业务完成。
try { await done; } finally { client.close(); }
```

processInYourTransaction 不是 SDK 内置函数。完整可运行样例：`npm run demo:worker`，仅自建回环 NATS、临时 SQLite 和合成订单，不连接生产服务。

## 选项

| 选项 | 默认 | 范围 / 含义 |
| --- | --- | --- |
| concurrency | 1 | 1..16；一批完成后再拉下一批，无隐藏预取队列 |
| maxMessages | 1000000 | 1..1000000；投递次数，包含重试，不是成功业务数 |
| expiresMs | 100 | 50..1000；请求期限上限，实际再封顶为 AckWait/3，避免批次未满却耗尽 ACK 等待 |
| handlerTimeoutMs | 30000 | 50..300000；超时停止，不自动重试可能仍有副作用的处理 |
| drainTimeoutMs | 5000 | 50..60000；停机等待预算，超时禁止迟到的新 ACK |
| heartbeatMs | 自动 | AckWait/3 与1000ms较小者；显式0禁用，非0至少20ms且小于 AckWait/2 |
| maxDeliveries | 5 | 1..100；失败达到上限后停止，不自动 TERM |
| retryDelayMs / maxRetryDelayMs | 100 / 30000 | 1..3600000；MoonBit 指数延迟封顶，不做立即热重试 |
| signal | 无 | AbortSignal，请求优雅停止，不关闭共享 Client |

启动查询配置，要求 durable、pull、explicit ACK。服务端 max_deliver 不小于 SDK maxDeliveries，max_ack_pending 不小于 concurrency，-1 表示无此上限。存在 backoff 时以第一项作为有效 AckWait。独立进程共享消费者时，本地 concurrency 不代表全局并发。

处理函数只收到 data/subject/headers/metadata/signal，不含 ACK 方法。成功后双 ACK；普通处理异常使用 MoonBit DeliveryPolicy 的延迟 NAK。投递耗尽、拉取失败、心跳失败、确认失败或处理超时均停止；错误只带稳定代码，不透传可能包含隐私的业务异常。

故障停止不盲目自重启。Client 可重连，但旧连接投递对象禁止 ACK/NAK/TERM；等待重投并按业务键去重。Message 在 NAK/TERM 后不能再结算，重复成功 ack() 仍幂等。

## 停机与极端情况

stop() 与 run() 等待同一结果。停止拉取后，已取得但尚未分派的消息留待超时重投，正常在途业务允许完成确认。drain 超时发送 AbortSignal、禁止迟到的新 ACK；已发送确认或外部写入不能撤回，网络心跳/确认仍受 Client timeout 限制，不能视为严格墙钟停机保证。

JavaScript 不能强杀忽略 AbortSignal 的异步业务。stats().unsettledHandlers 和 quiescent 反映是否真的退出；`await worker.waitForHandlers(5000)` 有界等待并返回布尔。未静止时，不要立即复用相关资源、重启同一任务或假设没有后台副作用。重启应创建新工作器，重复 run() 返回同一 Promise。

所有JS计时器都依赖事件循环；CPU密集同步处理或阻塞系统调用可阻止超时/心跳及时运行。重任务应放入受控Worker线程/独立进程并自行管理隔离与终止，不把本工作器的逻辑预算当作操作系统硬实时保证。

DELIVERY_LIMIT：人工检查并显式回放；HANDLER_TIMEOUT/DRAIN_TIMEOUT：先确认处理静止；HEARTBEAT_FAILED/PULL_FAILED/SETTLEMENT_FAILED：恢复连接并核对业务记录；SERVER_DELIVERY_LIMIT/SERVER_PENDING_LIMIT/UNSAFE_HEARTBEAT：修正配置。工作器不自动建死信流、TERM或删除。limits 流可 getMessage 或新建 start_sequence 消费者取回，但仍受流保留容量/时间限制，不承诺永久保留。需独立监控服务端投递耗尽，制定归档/告警与重放权限。

## 事务幂等示例的边界

examples/inbox-store.mjs 用内置 node:sqlite，将 eventId 唯一键与记账更新放进同一 BEGIN IMMEDIATE/COMMIT 事务。同 ID/同内容跳过，同 ID/不同金额拒绝；异常回滚两者。WAL/synchronous=FULL 是配置，不是实机断电证明。示例不提供生产数据库迁移、无限增长或过期清理策略。

演示复现“数据库已提交、消费 ACK 尚未发送”的中断并重新打开 SQLite，再接收重投；另用不同 NATS messageId 发布同一业务事件，最终只产生一笔效果。该事务不覆盖 HTTP、邮件、其他数据库；外部副作用须 outbox/接收方幂等，不能宣称端到端恰好一次。

Node >=22.13 可直接使用 node:sqlite；22.x 仍可能显示 ExperimentalWarning，这是运行时提示，不在测试中屏蔽。[Node 22 SQLite 文档](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html)。

## 运行指标

client.stats() 返回连接/重连、请求失败/峰值、发布/去重、投递/重投、ACK/NAK/TERM/working、协议收发字节和当前等待量。worker.stats() 返回成功/失败/重试/耗尽/超时/放弃、并发峰值、尚未退出的处理数。冻结快照不含端点、账号、凭据、业务ID、subject、payload或原始异常。字节数是协议层计数，不是 TLS 网络流量；本地放弃不代表服务端删除或业务成功。

官方语义参考：[NATS 确认与重投](https://docs.nats.io/learn/jetstream/acknowledgment)、[pull 消费](https://docs.nats.io/learn/jetstream/pull-consumers)。真实断电、集群故障、长期生产和外部用户未验证。

409 Batch Completed 正常结束；409 Message Size Exceeds MaxBytes 仅在已收到至少一条消息时返回部分批次，第一条就超预算仍失败。消费者删除等其他409仍明确拒绝，不把所有冲突当成功。核心 Frame 新增 description 字段，pull_status 按状态/说明/已收条数分类；直接构造 Frame 的旧消费者需补此字段。工作器实际拉取期限可看 stats().effectiveExpiresMs，网络延迟仍可能触发重投，不替代业务幂等。[官方服务端状态定义](https://github.com/nats-io/nats-server/blob/v2.15.1/server/consumer.go)。
