# 0.1.0 发布与复现记录

2026-10-13 已实际发布，不以 dry-run 或 CI 配置代替发布完成。

- 公开源码：https://github.com/bzhangui/moonjet
- Mooncakes：https://mooncakes.io/docs/bzhangui/moonjet
- 匿名注册表清单：https://mooncakes.io/api/v0/manifest/bzhangui/moonjet@0.1.0
- 版本：bzhangui/moonjet@0.1.0；未撤回，注册表 build_status=success。
- 发布时源码提交：e1542e99ba621132a933c329a35d021a340f539d。
- 注册表 ZIP SHA-256：98900685bb49d09aa517aaed2b2a72dd9f164175b07f162fb3b1455828ece540；与实际本地上传 ZIP 一致。
- Windows/macOS/Linux [代码基线 CI](https://github.com/bzhangui/moonjet/actions/runs/38380948342)：检查、构建、测试、样例、覆盖与运行包均通过。

## 独立消费者验证

另建空项目，通过 moon add 下载注册表依赖，不使用本仓库核心源码路径；核心样例在 JS/Wasm/Wasm-GC/Native 检查、构建、运行均通过。

```sh
moon add bzhangui/moonjet@0.1.0
```

已有 MoonBit 项目可导入 bzhangui/moonjet/core；完整示例见 examples/core。源码目录运行 node scripts/verify-registry.mjs 可自动新建 .local 下独立项目，复核四目标。Native 需要 C 工具链；失败不会跳过。

Mooncakes 提供可复用 MoonBit 核心，不会自动安装 Node、联网适配启动命令或测试服务。完整 MoonJet 执行环境仍按 README 从源码安装。

## 交付与隐私边界

README、许可证、NOTICE、安全说明、核心/适配源码与合成样例公开。申报示例、个人资料、凭据、真实业务数据、运行报告、临时证书、编译器和测试服务不公开。发布前核查 ZIP 条目和 Git；注册表登录凭据仅临时置于忽略的本地工具链，结束已移除。

Windows 启动器已实测选择演示再退出；单独运行包也已验证。运行包 SHA-256 清单提供完整性检查，不是签名或独立信任证明；测试报告不会附加到公开包。

注册表 0.1.0 为不可变发布快照；后续 GitHub 发布记录可以更新，不重新覆盖该版本。工程验收证据不保证赛事资格或获奖，有效开发提交由官方判断。真实外部用户、长期生产负载和未声明的协议/契约能力不在此次验证范围内。

