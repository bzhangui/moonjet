# MoonJet 本地运行包

需要 Node.js ≥22.13，不要求 MoonBit。Windows 双击开始使用.cmd，或运行 node scripts/install-server.mjs（或指定 NATS_SERVER），再 node examples/demo.mjs。新增事务幂等/消费演示：node examples/idempotent-worker.mjs；内置 SQLite 可能显示运行时实验提示。参数和停机见 docs/WORKER.md。

只对白名单文件打包，无个人资料、申报书、令牌、报告、测试证书、备份/消息数据、Git 或编译器。NATS 程序和 Node 不内置。SHA-256 是完整性检查，不是签名。

不要用演示程序对生产环境做故障注入。操作与交付边界见 docs/OPERATIONS.md、SECURITY.md。源码和安装更新见 https://github.com/bzhangui/moonjet 。

