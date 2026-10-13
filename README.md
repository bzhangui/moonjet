# MoonJet

以 MoonBit 为主要实现语言的 NATS JetStream 持久消息 SDK：有界二进制协议、持久发布、消息 ID 去重、确认、重投、回放、背压和断线恢复。

[源码](https://github.com/bzhangui/moonjet) · [CI](https://github.com/bzhangui/moonjet/actions) · [测试](docs/QUALITY_REPORT.md) · [操作与交付语义](docs/OPERATIONS.md)

## 实现范围

MoonBit 实现协议、JetStream 请求/ACK/PubAck/元数据、精确 uint64、在途窗口与退避；Node 适配 TCP、证书 TLS、计时器和异步调度。核心四目标可复用；**当前联网为 Node/JS 参考适配**，不冒称 Native/Wasm 已联网。支持 durable pull，不是完整官方客户端。

## 安装和独立演示

需要 [MoonBit](https://www.moonbitlang.com/download/) **moonc ≥ 0.10.15**、Node ≥ 22。维护 TLS 测试另需 OpenSSL ≥ 1.1.1；无 npm 第三方依赖。

```sh
git clone https://github.com/bzhangui/moonjet.git
cd moonjet
npm run build
node scripts/install-server.mjs
npm run demo
```

脚本下载官方 NATS 2.15.1 并核验 SHA-256，只存 `.local/tools`，不随 SDK 发布。`NATS_SERVER` 可指定本机程序，需自行核实来源/版本。

演示自建回环服务、随机端口、临时仓库，验证去重/确认、NAK、突停恢复/重连与历史回放，只清理自建进程和目录，不借用既有服务。Windows 可双击 **开始使用.cmd**。

## 最小使用样例

在有权限的服务运行，不把凭据写入 URL/源码。

```js
import {Client} from './platform/client.mjs';
const client = await Client.connect('nats://127.0.0.1:4222');
try {
  await client.createStream('ORDERS', 'orders.>');
  await client.createConsumer('ORDERS', 'WORKER', 'orders.>');
  const receipt = await client.publish('orders.created', Buffer.from('order-42'), {
    messageId: 'order-42-created', // 同一事件重试保持 ID 不变
  });
  for (const message of await client.fetch('ORDERS', 'WORKER', {batch: 1})) {
    console.log(message.metadata.stream_sequence, message.data.toString());
    // 业务操作先以稳定 ID 去重，再确认。
    await message.ack(); // 等待服务器确认收到 ACK
  }
  console.log(receipt.sequence); // 精确十进制字符串
} finally { client.close(); }
```

不同事件不能共用 ID。提供 `nak(delayMs)`、`working()`、`term()`、`getMessage(stream, sequence)`；消费者 `{start_sequence: '2'}` 回放。`max_ack_pending` 服务端背压，客户端最多 32 在途请求，无无限出站队列。

Token/user/password 从环境读入 options。远程明文凭据默认拒绝，选择 TLS：

```js
const client = await Client.connect('tls://nats.example.com:4222', {
  token: process.env.NATS_TOKEN,
  // 私有 CA 可指定 ca；不能关闭证书校验。
});
```

支持 INFO 后 TLS 升级。不支持 handshake-first、JWT/NKey、WebSocket、push、集群发现、KV/Object Store；未知连接/管理选项拒绝，避免误以为安全能力启用。

## 交付语义与维护

核心已发布至 [Mooncakes 0.1.0](https://mooncakes.io/docs/bzhangui/moonjet)，已有 MoonBit 项目可运行 `moon add bzhangui/moonjet@0.1.0`。安装与独立四目标验证见 [发布记录](docs/PUBLICATION.md)；完整执行仍需下面说明的 Node 适配环境。

按至少一次处理。PubAck 表示接受发布，去重有窗口；双重 ACK 表示收到消费 ACK，不保证业务事务或独立磁盘 fsync。实际单节点突停出现已确认消息重投，示例以业务键去重处理。

断线时未完成请求拒绝并说明结果可能不确定，不盲目自动重发。使用相同 messageId 重试，超去重窗口仍需业务识别。重连只回原端点。断电、集群切换、长期生产与外部试点未验证。

`bzhangui/moonjet/core` 提供 `Decoder`、`publish`、`subscribe`、`api_request`、`publish_ack`、`ack_metadata`、`Window`，见 `examples/core` 与 `core/pkg.generated.mbti`。发布状态见 [验收记录](docs/ACCEPTANCE.md)。

```sh
moon run examples/core --target native
npm run validate
npm test
node scripts/package.mjs
```

维护入口包含四目标核心、真实本地服务/证书、错误对端、样例/覆盖率。SDK 消息上限 1 MiB 含头部，pull 批量最多 256；详见 [OPERATIONS](docs/OPERATIONS.md)、[SECURITY](SECURITY.md)。

采用 [Apache-2.0](LICENSE)，依据 [NATS 协议](https://docs.nats.io/reference/protocols/client)、[JetStream API](https://docs.nats.io/reference/jetstream/api/) 独立实现，不移植 nats.js/nats.go，保留 [NOTICE](NOTICE)。
