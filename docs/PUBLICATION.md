# 发布与复现记录

## 0.1.1 修复版 — 2026-10-13

- 已实际发布 bzhangui/moonjet@0.1.1，匿名清单与 build_status=success 已确认，0.1.0未覆盖/撤回。
- 清单：https://mooncakes.io/api/v0/manifest/bzhangui/moonjet@0.1.1
- 上传源码提交：8cb350df538d7f2776ae94b7c83350acebead070。
- 上传ZIP SHA-256：41ba35f2d761cf7edf62688d5d625b934c4317a89dd98932b296541faec25af1，与注册表一致。
- [本轮三平台CI](https://github.com/bzhangui/moonjet/actions/runs/38407031655) 的检查、构建、完整测试、演示、覆盖与运行包均通过；本机15核心/32Node，详见QUALITY_REPORT。
- 独立项目通过moon add下载安装并运行四目标样例；另用独立非主入口测试包在四目标验证关键修复行为，无主入口测试弃用警告。
- node scripts/verify-registry.mjs 按当前版本生成独立消费者，包括修复回归；不使用本仓库的核心源码作为依赖。
- 两个发布包经文件条目检查，不含申报书、登录凭据、运行数据/报告、私钥或编译器。本轮临时登录副本已移除。

修复前问题与升级兼容变化见CHANGELOG、SECURITY；推荐0.1.1，不声称所有漏洞已穷尽。下面保留0.1.0历史证据。

## 0.1.0 历史发布

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

