# 发布与复现记录

## 0.3.0 源码升级，暂不发布 — 2026-10-30

本轮授权仅本地提交及 GitHub 推送，不发布 Mooncakes/公开运行包。0.3.0 已完成本机维护验证，详见 QUALITY_REPORT；新增三平台 CI 在推送后单独核验。只读注册表核对仍为 0.2.1，未撤回、校验和仍与下方历史记录一致。

本地 `moon package --frozen` 仅检查及打包，不执行 publish，不产生注册表发行版本；`.moonignore` 逐文件白名单持续执行。私人申报书、凭据、工具链/Go 安装、数据和原始报告排除。0.2.1 核心包仍可安装，但不包含0.3.0新增 API，勿混用安装说明或旧绿色证据。

源码 `2cff700` 已推送，新增 [三平台 CI](https://github.com/bzhangui/moonjet/actions/runs/41013569416) 全部通过；本地85文件源码归档逐字节/白名单核验及独立解压构建后的95项回归通过，28文件运行包三套样例独立实跑通过。以上均不构成注册表0.3.0发布，也没有上传运行包。

## 0.2.1 正式发布 — 2026-10-27

- **bzhangui/moonjet@0.2.1** 已实际发布：`moon publish --frozen` 退出 0、服务端 `200 OK`，不是 dry-run。修复提交 `7257710` 与版本/发布保护提交均已推送 GitHub；上传源码提交为 `aaf114d0a993ffe7d2d3cf7223daeb5543f4cb1c`。
- [本轮源码 CI](https://github.com/bzhangui/moonjet/actions/runs/40513909949) 对应上述源码提交，Windows、Linux、macOS 检查/构建/真实服务测试/覆盖和运行包独立实跑全部通过，不沿用旧版 CI。
- [匿名注册表清单](https://mooncakes.io/api/v0/manifest/bzhangui/moonjet@0.2.1) 已确认 `build_status=success`、`latest_version=0.2.1`、`yanked=false`。上传 ZIP SHA-256 为 `fa3ed9ae8ac4181de66f7c1e41e27fb16ad407aae20f0f2502c1f3ad326ad46d`，与注册表 checksum 一致。
- 发布 ZIP 精确包含 56 个获准文件，逐条比对白名单及已审查源码字节，LICENSE/NOTICE/标准库许可证均存在；未包含私人申报书、凭据、本机工具链配置、数据库、私钥、服务二进制、编译器、备份或原始报告。逐文件 `.moonignore` 不自动放行目录下新增文件。
- 本机四目标 18 个不同核心用例共 72 次执行、69 项 Node 回归、两套演示和 18 文件运行包通过，核心覆盖 397/458。上传前另从实际 ZIP 解压到独立私有目录，重新构建并通过全部 69 项 Node 回归，不只检查原工作目录。
- 发布后再建空项目，通过 `moon add bzhangui/moonjet@0.2.1` 独立下载；JS/Wasm/Wasm-GC/Native 检查、release 构建、公开核心样例以及每目标 2 项新旧 API 回归全部通过，共 8 次回归，不以本地核心路径作依赖。
- 发布直接使用原有登录目录与独立 0.10.15 工具链根分离配置，没有复制登录凭据或修改全局旧 SDK。申报书和本机配置仍仅在忽略目录/文件中保留，不上传桌面运行包。

实际上传 ZIP 已私有保留，不重打包覆盖 0.2.1。该不可变快照中的“发布准备”文字是上传前记录；本页与 GitHub README 为发布后补充证据。Mooncakes 提供四目标核心，Node 联网工作器仍需本仓库适配。旧版不覆盖/撤回；真实断电、集群、长期生产和外部试点证据仍缺失，不宣称端到端恰好一次。

## 0.2.0 正式发布 — 2026-10-22

- 已实际发布 **bzhangui/moonjet@0.2.0**，publish退出0、服务端200 OK；匿名清单确认build_status=success、latest_version=0.2.0、yanked=false，0.1.0/0.1.1未覆盖或撤回。
- [匿名注册表清单](https://mooncakes.io/api/v0/manifest/bzhangui/moonjet@0.2.0)；上传源码提交ad7439ecda16fa367e309f022745584803b8e5ea，含大消息部分批次与短ACK期限修复。
- 上传ZIP SHA-256：dcdf915fc99e200eede88b644836ced3a0774d03763d93408934a23600619bea，与注册表metadata.checksum一致；52条目核查不含申报书、凭据、私钥、数据库、报告、编译器或服务二进制，LICENSE/NOTICE均存在。
- [本轮源码CI](https://github.com/bzhangui/moonjet/actions/runs/39774733181)：Windows、Linux、macOS检查/构建/核心与真实服务回归、覆盖、两套演示及18文件运行包实跑全部通过；不沿用旧版结果。
- 独立空项目经moon add实际下载0.2.0；JS/Wasm/Wasm-GC/Native检查、release构建、核心样例和每目标2项公开API回归全部通过，共8次回归。新DeliveryPolicy、pull_status和历史硬化行为均验证，不用本仓库核心源码作依赖。
- 本机18个不同核心用例×4目标、55项Node回归，核心397/458；完整边界见QUALITY_REPORT。Node>=22.13，仅联网参考适配和SQLite示例需要Node；Mooncakes提供四目标核心，不自动安装Node工作器或NATS服务。
- 发布使用已授权登录主目录与独立0.10.15工具链根分离配置，没有复制登录凭据或改变全局旧SDK。dry-run遇到服务端202明确确认、旧CLI却非零退出的兼容问题；仅记作试运行接受，正式200及独立安装另行验证，不将失败命令当正式发布成功。

实际上传ZIP已私有保留，不会用发布后文档重新打包覆盖0.2.0。该不可变快照中的“发布准备”是发布前记录；本页为GitHub后补发布证据。私人申报书更新保留AI示例声明，仅在本地；源码、使用说明、许可证与合成样例公开。真实断电、集群、长期生产与外部试点缺口继续保留。

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

