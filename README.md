# MoonJet

面向 MoonBit 的 NATS JetStream SDK：持久发布、Pull/Push 消费、管理、集群发现、安全认证、KV 与 Object Store。

[GitHub](https://github.com/bzhangui/moonjet) · [CI](https://github.com/bzhangui/moonjet/actions) · [完整使用指南](docs/SDK_GUIDE.md) · [兼容矩阵](docs/COMPATIBILITY.md) · [测试记录](docs/QUALITY_REPORT.md)

## 当前版本与实现边界

当前源码 **0.3.0** 扩展了六类能力：流/消费者完整配置入口及管理、Push/队列组/确认策略、可信集群发现和故障恢复、NKey/JWT/credentials/mTLS/TLS-first、KV、分块 Object Store。已有 PullWorker、业务幂等示例和故障保护保留。[更新记录](CHANGELOG.md)列出变化。

MoonBit 实现协议编解码、JetStream 请求计划、38/35 项顶层配置目录与类型校验、精确整数、ACK/PubAck/元数据、NKey 编码校验、KV 配置、对象身份/计数/摘要格式校验、窗口及投递策略。Node 负责网络、系统密码学、计时器和异步存储流程。核心四目标可复用；**联网当前仅 Node/JS**，不将四目标编译成功说成四目标已联网。

本轮不是 nats.go/nats.js 完全等价认证。嵌套配置和跨字段约束由服务端验证；镜像 KV 自动源路由、WebSocket、Native/Wasm 网络、跨主机分区、真实断电和长期生产验证仍有边界，详见兼容矩阵。

**发布区分**：0.2.1 是上一已发布 Mooncakes 基线；本轮 0.3.0 仅进行源码推送，不发布 Mooncakes 或公开运行包。不要尝试安装尚未发布的 0.3.0。旧版登记证据见[发布记录](docs/PUBLICATION.md)。

## 安装与复现

需要 [MoonBit](https://www.moonbitlang.com/download/) **moonc ≥0.10.18**、Node ≥22.13。本机验证 SDK 为 0.10.18。完整维护测试另需 OpenSSL ≥1.1.1 和 Go ≥1.26（CI 固定 Go 1.27.3）。

生产适配不依赖第三方 npm SDK；开发测试锁定官方 nats.js/nkeys，Go 仅构建 nats.go/JWT 参考程序。npm 使用锁文件，Go 使用 go.mod/go.sum；它们不是生产代理实现。

```sh
git clone https://github.com/bzhangui/moonjet.git
cd moonjet
npm ci --ignore-scripts
npm run toolchain -- --check
npm run build
node scripts/install-server.mjs
npm run demo
npm run demo:worker
node examples/platform-demo.mjs
```

工具链太旧时，可用 `npm run toolchain -- --moon "C:\path\to\sdk\bin\moon.exe"` 指定独立 SDK，Unix 用绝对路径。只写入忽略的 `.local/toolchain.json`，不更改全局 PATH 或复制登录凭据。优先级：MOON_BIN → 私有配置 → 项目 SDK → PATH。直接执行 moon 仍使用终端自己的环境。

下载脚本固定官方 NATS Server 2.15.1 并验证 SHA-256，仅保存 .local/tools；可用 NATS_SERVER 指定自行验证的程序。演示启动独占回环服务、随机端口和临时合成数据，不借用或修改已有服务。Windows 可双击[开始使用.cmd](开始使用.cmd)。

## 最小持久消费

```js
import {Client} from './platform/client.mjs';
const client=await Client.connect('nats://127.0.0.1:4222');
try {
  await client.createStream('ORDERS','orders.>');
  await client.createConsumer('ORDERS','WORKER','orders.>');
  await client.publish('orders.created',Buffer.from('order-42'), {
    messageId:'order-42-created', // 同一业务事件重试保持不变
  });
  for(const message of await client.fetch('ORDERS','WORKER',{batch:1})) {
    // 先完成带业务幂等键的处理，再确认。
    await message.ack();
  }
} finally { client.close(); }
```

为不同事件使用不同 messageId，序号使用精确十进制字符串。提供 nak(delayMs)、working()、term() 与历史回读；超时/断线不确定结果不会自动重发。至少一次投递不等于业务恰好一次，去重有窗口，ACK 也不等于独立磁盘 fsync。

Push、完整管理、安全多 seed 连接、KV CAS/watch、对象流式读写与快照恢复示例见[SDK_GUIDE](docs/SDK_GUIDE.md)。有界并发、处理失败、优雅停机、SQLite 事务幂等和指标口径见[WORKER](docs/WORKER.md)。

## 测试、合规与维护

```sh
npm run validate
node scripts/verify-portable.mjs
```

validate 覆盖四目标检查/构建/测试/核心样例、真实回环单节点/三节点 NATS、TLS/mTLS、NKey/JWT、两种官方客户端互操作、畸形输入/配额/断线/摘要损坏和三套演示。需 Go/OpenSSL，不静默跳过缺失环境。单独 npm test 前先 build、安装测试服务、执行 node scripts/prepare-go-interop.mjs。

[质量记录](docs/QUALITY_REPORT.md)区分本机结果与本轮远端 CI；[验收记录](docs/ACCEPTANCE.md)区分源码与注册表发布。运行包采用逐文件白名单和 SHA-256，不含私人申报书、凭据、原始报告、数据、测试私钥、官方参考 SDK 或编译器，哈希不等于数字签名。只在本机验证，不公开发布本轮运行包。

采用 [Apache-2.0](LICENSE)，保留 [NOTICE](NOTICE) 和标准库许可证。参考 NATS 官方协议独立实现；nats.js/nats.go/JWT 仅作开发期对照，未复制其实现。安全边界见 [SECURITY](SECURITY.md)，故障处置见 [OPERATIONS](docs/OPERATIONS.md)。
