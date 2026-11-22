# dsh-shiori

> DeepSeek Harness 的分层长期记忆插件：把记忆从对话流里搬出来，按「常驻核心 / 关键词闪回 / 按需长文」分层存放，满了下沉、旧了归档。

[![host](https://img.shields.io/badge/DSH-0.2.1--rc.2%20–%200.2.2--rc.1-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/dsh-shiori)](https://www.npmjs.com/package/dsh-shiori)
[![downloads](https://img.shields.io/npm/dm/dsh-shiori)](https://www.npmjs.com/package/dsh-shiori)
[![license](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-green)](LICENSE)

---

## 30 秒上手

```powershell
# 从 npm 安装（推荐）
npm install dsh-shiori

# 或通过 DSH CLI 安装
dsh plugin --profile web add dsh-shiori
```

插件默认以只读 `shadow` 模式挂载。在 `cordis.patch.yml` 中配置两个互不嵌套的绝对路径并开启 `active`，重启生效（若装有同类的 `dsh-soul-md` 请先停用）：

```yaml
- id: shiori
  name: dsh-shiori
  config:
    mode: active
    allowActive: true
    dataRoot: '/absolute/path/to/shiori-data'   # 记忆数据根目录（Markdown + JSON 明文）
    stateRoot: '/absolute/path/to/shiori-state' # 运行状态与投递账根目录
```

## 一张表看懂记忆分层

| 层级 | 存什么 | 怎么进上下文 | 满了 / 旧了怎么办 |
| --- | --- | --- | --- |
| **L0 人设卡** | 身份、性格与说话规则 (`persona/*.md`) | 每轮常驻最开头 | 整卡替换（上限 60000 字），按工作区/会话隔离 |
| **L1 记忆核心** | 当前重要事实与约定 (`core.md`) + 专题索引 | 每轮常驻 | 超软目标提示模型**下沉**到 L3；超硬上限退回安全投影，绝不截断 |
| **L2 Spark 卡** | 原子记忆：梗、外号、小事实 (`sparks.json`) | 平时占 0 字；对话命中 `triggers` 或本地语义近邻时作为附件浮出 | 同一轮周期防刷屏冷却；`ephemeral` 卡按半衰期（30–240天）淡出归档 |
| **L3 专题** | 项目档案、长篇笔记 (`topics/*.md`) | 只在 L1 占一行索引；模型调 `memory_read` 才读全文 | 冷专题可移出索引转为归档，保留全文供检索 |

## 核心保障

- **Web 原生管理面板**：插件详情页内建 **状态 / 最近变更 / 记忆 L0·L1 / Spark 力导向图谱 / 整理与遗忘 / L3 主题 / 闪回命中 / 预算** 八个标签页，可视化编辑卡片连线、预览整理计划。
- **19 个模型侧工具**：涵盖人设读写、L1 核心改写、L3 专题分组/检索与追加、L2 卡片增删改、单条连线管理与图谱读取，均由模型自主调用。
- **数据不丢、不乱覆盖**：全明文落盘在包外目录，卸载不删数据；写操作强制带 `operationId`（幂等重试）与 `CAS revision`（防并发覆盖）；多进程抢同一目录时自动单写者锁降级只读；「遗忘」只归档不物理删除。

## 文档导航

| 想看什么 | 去哪里 |
| --- | --- |
| **AI Agent 专属速查（19 个工具调用规范、Scope 规则、测试命令与代码红线）** | **[AGENTS.md](AGENTS.md)** |
| 开发者架构设计、双根磁盘布局、参数与错误码全量字典 | **[DESIGN.md](DESIGN.md)** |
| 完整配置项、面板 8 个 Tab 详解、19 个工具签名、常见报错排查 | **[docs/USAGE-GUIDE.md](docs/USAGE-GUIDE.md)** |
| 安装、首次配置、升级与卸载步骤 | **[docs/plugin/INSTALL.md](docs/plugin/INSTALL.md)** |
| 面板 RPC 通道、授权边界与宿主降级行为 | **[docs/plugin/client.md](docs/plugin/client.md)** |
| 历史版本发布说明与变更记录 | **[docs/releases/README.md](docs/releases/README.md)** |

## 在已安装的包里跑测试

npm 包自带 `scripts/`（测试运行器）与 `test/`（两层测试），装包后可以在包目录里直接跑包内测试（v0.4.0 起）：

| 命令 | 跑什么 |
| --- | --- |
| `npm test` | 开发层（dev）全套测试 |
| `npm run test:release` | 开发层 + 发版门禁层全量（含真实 DSH CLI 冒烟、stage 旧回归、boot 存活窗口等慢用例） |
| `npm run verify:package` | 包清单 / tarball / 包内可收集性核查 |

前置条件：

- **Node.js >= 24**（`engines.node` 要求，测试运行器同样依赖 node:test）；
- **peer 依赖可解析**：通过 `dsh plugin --profile <n> add <tgz>` 安装时自动就位；若把包手动放进某个目录直接跑测试，需先自行安装 `peerDependencies`（react、zod、@deepseek-ai/dsh-* 等）；
- **环境类用例如实标注**：本机未装 DSH CLI 时，真实冒烟 / boot 存活窗口用例按契约 not-run（不会假绿）；`npm run test:release` 的完整覆盖需要装好 DSH 0.2.1-rc.2。

`npm run verify:package` 里有一项「tarball collect」：真实 `npm pack` → 解包到临时目录 → 在解包目录执行 `node scripts/run-tests.mjs dev --collect-only`（只跑分层守卫并打印收集清单，不运行测试），证明装包人手里那份 `test/` + `scripts/` 能被包自带运行器完整收集。

## 版本更新

<details open>
<summary><b>v0.5.x</b></summary>

### v0.5.0-beta.1 · 2026-11-23（测试版：专题温度与自动冷却 / 面板八页签 / 设置四子页）

- **专题温度**：每条专题有「长期保留」与「有来有去」两种生命周期，按稳定性与热度算 active / cool / cold / frozen 四档，纯函数、可按时间回放预览。
- **可逆自动冷却**：自动只做归档与还原，每轮最多 20 条，带审计与一键撤销；拆篇、合并、改写正文永远不会自动执行。
- **参数面板**：温度相关 12 项参数集中一处，改完即生效，支持「如果开自动，哪些会变冷」的模拟。
- **面板八页签**：概览只读、专题整理承接写操作、闪回图谱分页、人设与核心独立成页、最近变更合并成一条流；旧页签入口保留别名跳转。
- **设置四子页**：预算 / 温度 / 闪回卡片 / 向量召回。
- **专题分组**：专题可挂多个分组，删组时成员可迁移，遗留悬空引用一次清掉。
- **去重与对齐**：专题页只读、整理页二级分页且切换不丢勾选、闪回每页条数统一、人设切换收进编辑卡、预算页去掉重复的闪回卡片段。
- **修复**：切温度档位不再被宿主拒绝；启动差集门控改用实际收场信号；读分组越界与父分组悬空降级为提示；分组错误码统一，删组并发不留半迁移。
- **注意**：这是测试版，自动冷却建议先设为只提示观察一段时间；默认安装仍是 0.4.0，想试请装 `dsh-shiori@next`。

</details>
<details>
<summary><b>v0.4.x</b></summary>

### v0.4.0 · 2026-11-15（装完即用 / 侧边栏入口 / 分组 / 分页 / 模型下载 / 卸载焚毁 / 图谱两级视图）

- **首次安装可用**：数据与状态根目录默认落到 `~/.dsh/shiori-data`、`~/.dsh/shiori-state` 并自动创建；面板给「启用记忆」按钮与初始化卡片，不再只有一行 needs-configuration。
- **侧边栏独立入口**：侧边栏出现「记忆」图标，点开直达全屏面板。
- **专题分组**：专题可挂多个分组（首个为主组），新增分组管理 UI 与 `group_manage` 工具；L1 索引仍平铺。`group_manage` 增 `repair` 动作与 `list.dangling`，删组时并发留下的悬空引用可一次清掉。
- **面板分页与人设卡**：最近变更、专题、闪回命中统一每页 10 条；会话顶部可切人设卡，切卡即换整套记忆。
- **模型下载**：状态页可一键下载语义模型到数据目录，带进度，失败可手动指定目录。
- **卸载与焚毁**：新增 `dsh-shiori-admin` 命令与面板危险按钮，二次确认后删除整个数据目录。
- **图谱两级视图**：首屏只画簇圆，点开进簇内画连线，带面包屑。
- **修复**：进簇过渡期不再闪假空态；时间线回退下界钳到 0；清簇不再清空地图；迁移断言不再写死组名；换模型后自动重建改为强制全量（旧维度向量不再残留）；图谱节点带实体标签，图例名副其实；数据根落在 junction / symlink 上不再启动即失败。
- **可测与分层**：包内携带 `scripts/` 与 `test/`，装包后可原地 `npm test`；分层靠文件位置而非排除清单。

</details>

<details>
<summary><b>v0.3.x</b></summary>

### v0.3.1 · 2026-11-11（修复核心正文误存派生索引）

- **核心正文不再重复累积索引**：写入核心的正文若夹带读取时拼出的主题索引，现在会被拒绝并提示只传正文；三个写入入口口径一致。

### v0.3.0 · 2026-11-08（专题归档 / 图谱改版 / core 写入收敛）

- **专题归档**：专题可移出 L1 索引转为冷专题，正文仍可按需读取与检索。
- **图谱与专题页改版**：力导向图支持重要度节点缩放、hover 高亮、搜索定位与键盘操作；专题页新增搜索、排序与归档状态。
- **core 写入收敛**：统一收敛为 `core_write` 单一路径，修复会话切换竞态与整理计划误作废问题。

</details>

## 许可

[CC BY-NC-SA 4.0](LICENSE)（署名 · 非商业性使用 · 相同方式共享）
