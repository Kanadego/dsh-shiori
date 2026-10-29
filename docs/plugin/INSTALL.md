# dsh-shiori 安装 / 卸载指南

只用 DSH 原生命令，不手改 Cordis YAML、不自造 installer。`dsh plugin` 把参数原样转发给 profile 目录内的 pnpm；包声明了 `dsh.bundle.patch`（`cordis.patch.yml`）之后才作为 bundle 挂载，普通 dependency 不会激活。

## 前置条件

- Node `>=24`，DSH `>=0.2.1-rc.2 <0.3.0`，`pnpm` 在 PATH 上。
- 若同时启用 `dsh-soul-md`：两者提供 9 个同名工具（`soul_read` / `memory_append` 等），宿主「工具唯一提供者」校验会拒绝。先在原 profile 停用 soul-md，或使用独立 profile。

## 安装（npm）

~~~bash
dsh plugin --profile <name> add dsh-shiori
~~~

## 安装（本地 tgz）

~~~bash
# 1. 在包目录产出候选 tgz
npm pack
# => dsh-shiori-0.1.0.tgz

# 2. 安装到目标 profile（profile 是名称，不是路径）
dsh plugin --profile <name> add /absolute/path/to/dsh-shiori-0.1.0.tgz

# 3. 验证挂载（compose 会 import 插件并打印组合树；EXIT=0、stderr 无 shiori 报错）
dsh --profile <name> --dump-config
~~~

安装成功后：profile 的 `package.json` 中 `dsh.profile.bundles` 自动追加 `dsh-shiori`（重复安装不重复追加），`node_modules/dsh-shiori` 就位并携带 `cordis.patch.yml`。

## 首次配置

默认 inert shadow：挂载成功但显示 `needs-configuration`，不读写业务数据。在设置页（本包详情 → 预算配置）或 profile 的 `cordis.patch.yml` 里配置：

- 保持 shadow 只读：设置 `dataRoot` / `stateRoot` 为两个绝对、互不嵌套的目录；
- 启用 active：`mode: "active"` + `allowActive: true` + 上述两个根。

保存经宿主原生配置服务提交：`budgets` 是宿主认可的 volatile 字段，由宿主热提交、不触发插件重载。运行中的 controller 仍使用启动时快照，新预算在下次插件重载或宿主重启后生效。

## 升级

~~~bash
dsh plugin --profile <name> remove dsh-shiori
dsh plugin --profile <name> add dsh-shiori@<版本>
# 重启宿主
~~~

升级前建议先备份 `dataRoot` 与 `stateRoot`（两个都要，缺一不可）。

## 卸载

~~~bash
dsh plugin --profile <name> remove dsh-shiori
~~~

卸载只移除包与 bundle 挂载；`dataRoot` / `stateRoot` 中的全部记忆数据保留，不做任何删除或迁移。不自动停用 soul-md，不修改其他插件。

## 故障速查

| 现象 | 处置 |
| --- | --- |
| `tool ownership conflict ... soul-md` | 同名工具冲突：停用 soul-md 或换独立 profile |
| 安装后 `--dump-config` 报 peers 缺失 | profile 基础栈未含所需服务；确认 profile 基于 `@deepseek-ai/dsh-base` 模板 |
| `pnpm was not found` | 安装 pnpm 并加入 PATH |
| 面板显示 `shiori/ui-unavailable` | web 前端未挂载 typert Gateway（transport unavailable）——仅工具模式，属如实诊断 |
| needs-configuration 常驻 | inert shadow：配置两个绝对根后重启 profile |
| profile 名为 `desktop` 时命令行报错 | 该 profile 由 Electron 应用独占管理，改用应用内插件市场安装 |
