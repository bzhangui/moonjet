# 管理、Push、认证与存储使用指南

先按 README 构建。以下操作仅用于自己有权限的 NATS 服务；同一 Client 可复用，退出时 `close()`。所有示例使用合成资料，不运行在未知或生产账户上。

## 完整配置与管理

```js
await client.createStreamConfig({
  name: 'EVENTS', subjects: ['events.>'], storage: 'file',
  max_bytes: 67108864, num_replicas: 1,
  metadata: {purpose: 'example'},
});
await client.updateStream({...((await client.streamInfo('EVENTS')).config), description: 'updated'});
for await (const stream of client.streams()) console.log(stream.config.name);
await client.createConsumerConfig('EVENTS', {
  name: 'WORKER', durable_name: 'WORKER', ack_policy: 'explicit',
  filter_subjects: ['events.created', 'events.updated'],
});
await client.pauseConsumer('EVENTS', 'WORKER', new Date(Date.now()+60_000).toISOString());
await client.resumeConsumer('EVENTS', 'WORKER');
```

配置字段采用 NATS 原生蛇形名称，不静默剥离未知字段。整数超出 JS 安全范围时传规范十进制字符串；由 MoonBit 输出真正的 JSON 数字。返回序号始终是字符串，其他超安全整数计数也以精确字符串返回。配置 duration 为纳秒，带 `Ms` 的便利接口为毫秒，勿混用。嵌套配置原样传送，服务端负责语义和不可变规则，拒绝时保持明确 API 错误码。

`management(operation, stream, consumer, options)` 是受限操作目录，不接受任意指令注入。可用 action 见 `core/management.mbt`；分页迭代最多 4096 页，空页但总数未达时报错，不当作成功。

快照 `snapshotStream('EVENTS', {maxBytes: 67108864, noConsumers: false})` 返回 `{config,state,data}`；删除/迁移目标准备完毕后 `restoreStream('EVENTS', snapshot)`。这是显式有界内存快照，不是无限规模备份工具。恢复分块等待回执，最终等待流创建结果；中途失败可能留下服务端未完成状态，不盲目删除或重试。暂停写入取得业务一致备份由调用方负责，勿直接删除线上流来试验。

## Push 和确认策略

```js
const messages = await client.pushSubscribe('EVENTS', 'PUSH', {
  config: {filter_subject:'events.>', ack_policy:'explicit',
    idle_heartbeat:'5000000000', flow_control:true, max_ack_pending:128},
  maxMessages:256, maxBytes:8388608,
});
try {
  for await (const message of messages) {
    await handleIdempotently(message);
    await message.ack();
  }
} finally { messages.close(); }
```

绑定现有消费者用 `{bind:true}`，队列组必须与 `deliver_group` 相符。AckAll 的后续确认会累计确认此前投递，不能将其误作并行任务各自独立确认；需要独立结算时使用 explicit。AckNone 没有可靠消费确认，调用 `ack/nak/working/term` 会拒绝。`drain()` 先取消订阅并完成服务端屏障，保留已接收缓存供后续迭代；`close()` 立即丢弃本机缓存但不删除持久消费者。缓冲超限会报错，不静默丢弃并返回成功。

## 集群与安全

```js
import {Client, credentialsAuthenticator} from '../platform/client.mjs';
const client = await Client.connect(['tls://nats-a.example:4222','tls://nats-b.example:4222'], {
  authenticator: credentialsAuthenticator(process.env.NATS_CREDS_FILE),
  discoveryAllowlist: ['nats-a.example','nats-b.example','nats-c.example'],
  pingInterval: 10_000,
});
```

默认仅接受种子主机名上发现的新端口；加入其他主机需明确 allowlist。单池禁止混用 TLS/明文，不接受 URL 内密码，不接受服务发现中的用户信息。allowlist 是授权主机名边界，不是 DNS pinning；保护 DNS、CA 和账号权限仍由部署方负责。INFO 后 TLS 与 `{tlsHandshakeFirst:true}` 均支持，证书检查不可关闭；mTLS 使用 `cert`/`key` 成对提供，`ca`/`serverName` 按部署设置。凭据读取/签名回调每次握手重新调用；支持 `nkeyAuthenticator`、`jwtAuthenticator` 和 credentials 文件，不把种子放在日志或示例中。

重连恢复订阅，不自动重发结果不确定的 PUB；同事件复用 messageId，超去重窗口后仍需要业务幂等。断开前的 Message 禁止在新连接确认。重连耗尽、心跳超时、慢消费和配额不足都必须由应用处理。

故障恢复期间，503 表示服务暂不可用；`err_code=10158` 表示相同 messageId 仍在处理，不能改用新 ID 绕开去重。调用方可有界等待并查询/用同 ID 重试，但本 SDK 不自动替业务重发。权限/配置/CAS 错误不按瞬时可用性错误重试。

`waitConnected()` 只证明 NATS 连接恢复，不证明 JetStream 的 Raft 选举已结束。可再调用 `waitJetStream({stream:'EVENTS',consumer:'WORKER',timeout:15000})` 有界轮询只读状态；它仅重试 503/选举暂不可用，不重试权限错误，也不重发写入。选举期间写操作仍可能遇到竞态失败，应用保留同一 messageId 后显式决定是否重试，不把等待方法当作事务锁。

## KV

```js
const kv=await client.createKeyValue('SETTINGS',{history:8,maxBytes:67108864,ttlMs:0});
const rev=await kv.create('app.version',Buffer.from('1'));
await kv.update('app.version',Buffer.from('2'),rev); // 服务端原子 CAS
const entry=await kv.get('app.version');
for await (const old of kv.history('app.version')) console.log(old.revision);
const updates=await kv.watch('app.>');
try { for await (const event of updates) {
  if(event.initialized) console.log('initial snapshot complete');
  else console.log(event.key,event.operation,event.revision);
}} finally { await updates.close(); }
```

已有桶用 `keyValue(name)`。history 1..64；TTL 0..2147483647ms；容量/副本必须在账户配额内（默认 KV 64MiB，Object Store 256MiB）。`delete` 写 DEL 墓碑，`purge` 写 PURGE 并清除旧版本，`create` 可 CAS 重建已删除键。`get(...,{revision})` 验证该版本属于请求键；revision 是精确字符串，不是业务版本号。流级 revision 不是单键连续计数。

keys/history 是有界枚举，不是分布式多键原子事务；枚举期间的源变化可导致失败，应用重试。watch 先初始集合再 `{initialized:true}`，之后实时更新。连接代次变化即报 continuity lost 并清理，应用重新获取全量视图，不能把重连间隙当作零丢失监听。

## Object Store

```js
const store=await client.createObjectStore('FILES',{maxBytes:268435456});
await store.put('archive.bin',readableByteStream,{maxBytes:67108864,chunkSize:131072});
const result=await store.get('archive.bin',{maxBytes:67108864});
if(result) for await (const chunk of result.data) await consume(chunk);
// 或 getBytes()：有界聚合，完整校验成功才返回 Buffer。
await store.link('alias','FILES','archive.bin');
```

input 是 Buffer/Uint8Array 或逐块字节的同步/异步 iterable。单次 put/get 默认64MiB、显式最大1GiB，下载最多10万块，层级链接最多16层且拒绝循环。流式读取必须消费到 EOF 才完成 size/chunks/SHA-256 校验；提前停止或中途损坏不等于已验证，不应提前发布最终业务文件。

元数据发布使用上一 revision 的 CAS；分块完成后才提交元数据。提交前失败只清理本次独有分块；元数据发布开始后的失败可能已提交，保留分块、由调用方查询状态，不误删。覆盖和删除不会自动清理旧代分块，保护并发读者；空间会保留，需安排静默维护窗口。`garbageCollect()` 默认只读审计；实际回收需停止该桶全部读写，再明确 `{dryRun:false,confirmQuiescent:true}`。元数据复查不是分布式锁，不能在活跃写入环境执行回收。seal 不可逆；destroy 会删除整个桶，均需调用者明确操作。

测试范围、官方互操作和未验证边界见 [COMPATIBILITY](COMPATIBILITY.md)；生产交付语义见 [OPERATIONS](OPERATIONS.md)。
