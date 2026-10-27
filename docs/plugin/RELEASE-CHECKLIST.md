# dsh-shiori 发布核对清单（0.1.0-alpha.1 本地候选）

> 本清单是「首次公开 GitHub/npm 发布或宣称 DSH 宿主兼容」前的闸门。当前全部项按本地候选口径执行；未过项如实 not-run，不得宣称。

## 包清单（`npm run verify:package` + `test/plugin/package.test.mjs`）

- [x] `name=dsh-shiori`、`version=0.1.0-alpha.1`、`private=true`（阻止误 publish）、`license=UNLICENSED`（未定，如实标注）
- [x] `type=module`、`main=index.mjs`、`exports["."]/["./client"]/["./package.json"]` 齐全
- [x] `engines.node>=24`、`engines.dsh>=0.2.1-rc.2 <0.3.0`（仅对已测 0.2.1-rc.2 声明范围）
- [x] `dsh.manifestVersion=1`、`dsh.bundle.patch=./cordis.patch.yml`、`dsh.client={platform:web}`（seed require≠图依赖，见 client.md 三层语义）
- [x] `files` 白名单不含 `phase*/collab/备份/测试 profile/凭据/真实数据`；tarball 内容经 `npm pack --dry-run --json` 断言
- [x] 相对 import 完整性：包内文件全部可达（P 槽 `controller.mjs/protocol.mjs` 计为组合后存在，单槽副本中列为 expected-from-P）
- [x] client bundle：ModuleLoader 工厂、无 innerHTML、无 CDN、无 eval；内嵌 CSS 与 `client/shiori.css` 一致
- [x] 不含机器绝对路径 / 用户目录 / 凭据（对 shipped 文件扫描）

## 隔离宿主验收（`test/plugin/dsh-smoke.test.mjs`，真实 DSH CLI + 系统 temp）

- [x] 全新隔离 profile（独立 `DSH_HOME`/`DSH_AGENTS_HOME`/cwd），本地 tgz `dsh plugin add` 成功激活
- [x] `dsh.profile.bundles` 追加 `dsh-shiori`；重复 add 不重复 bundle
- [x] `--dump-config` EXIT=0：真实 Cordis 装配 + Config schema 编译通过（controller 为 temp 合成 stub，如实标 synthetic）
- [x] `dsh plugin remove`：包与挂载移除，**dataRoot/stateRoot 数据保留**
- [x] 安装失败恢复证据按实际场景记录（无伪造宿主原子性声明）

## 上线前仍须完成（当前未跑，如实 not-run）

- [ ] owner 组合真实 P+Q（不可变封包）后的完整双槽验收——单槽 synthetic stub 不算
- [ ] 真实宿主工具 runner 全量输出校验（16 工具成功回执，特别是 topic_append 写成功返回成功）
- [ ] 真实 provider / billion-context 出站矩阵（不发付费请求，须用户确认计费与次数）
- [ ] `npm name` registry 唯一性验证与正式 license 拍板（当前 UNLICENSED）
- [ ] 公开 publish（用户决策；agent 不擅自执行）

## 回滚

卸载命令即可回滚挂载与依赖；数据根目录不被动。真实 profile 任何改动须先快照（本批未做、也未授权）。
