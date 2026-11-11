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
- **16 个模型侧工具**：涵盖人设读写、L1 核心改写、L3 专题检索与追加、L2 卡片增删改与图谱读取，均由模型自主调用。
- **数据不丢、不乱覆盖**：全明文落盘在包外目录，卸载不删数据；写操作强制带 `operationId`（幂等重试）与 `CAS revision`（防并发覆盖）；多进程抢同一目录时自动单写者锁降级只读；「遗忘」只归档不物理删除。

## 文档导航

| 想看什么 | 去哪里 |
| --- | --- |
| **AI Agent 专属速查（16 个工具调用规范、Scope 规则、测试命令与代码红线）** | **[AGENTS.md](AGENTS.md)** |
| 开发者架构设计、双根磁盘布局、参数与错误码全量字典 | **[DESIGN.md](DESIGN.md)** |
| 完整配置项、面板 8 个 Tab 详解、16 个工具签名、常见报错排查 | **[docs/USAGE-GUIDE.md](docs/USAGE-GUIDE.md)** |
| 安装、首次配置、升级与卸载步骤 | **[docs/plugin/INSTALL.md](docs/plugin/INSTALL.md)** |
| 面板 RPC 通道、授权边界与宿主降级行为 | **[docs/plugin/client.md](docs/plugin/client.md)** |
| 历史版本发布说明与变更记录 | **[docs/releases/README.md](docs/releases/README.md)** |

## 版本更新

<details open>
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
