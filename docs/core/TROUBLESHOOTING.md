# Shiori P0-CORE · 故障/报错速查表

> 适用：`src/core`（slot A 纯规则模块）。测试命令（slot 根目录）：
> `node --test test/core/*.test.mjs`；快速自检：`node test/core/diagnose.mjs`。
> 全部错误形如 `Error`，带 `code` 与 `name="ShioriError"`，消息含具体字段与数值。

## INVALID_INPUT 报错速查

| 报错消息（节选） | 原因 | 处理 |
| --- | --- | --- |
| `key must be a string` / `key must not be empty` / `at most 128 UTF-16 chars` | key 类型/长度非法 | 检查调用方是否传了非字符串或超长 key |
| `key must not contain forbidden filename character "X"` | 含 `<>:"/\|?*` | key 是文件名，去掉路径/盘符/通配符 |
| `key must not consist only of dots` / `must not start with a space` / `must not end with a space or dot` | 点号名或首尾空白 | 换合法文件名（Windows 限制） |
| `key "…" collides with a Windows reserved device name` | CON/NUL/COM1 等（含扩展名） | 换名字；`console`/`contact` 等前缀相似名不受影响 |
| `key "…" collides with the reserved Shiori alias "core"` | `core`/`core.md`（任意大小写） | 这些名字留给核心文件别名，专题换名 |
| `key must not contain lone surrogate code units` | 含未配对的 U+D800–U+DFFF（UTF-8 编码会归并为 efbfbd，造成身份碰撞） | 修正来源字符串的编码；合法 emoji/非 BMP 字符不受影响 |
| `config must be a plain object` / `config.X must be a plain object` | 配置结构非对象 | 检查是否传 null/数组/字符串 |
| `config must be a plain object, got Date/Map/Set/…` | 用 Date/Map/类实例等充当配置 | 配置与各段必须是普通记录对象（字面量或 `Object.create(null)`） |
| `config has unknown top-level property "X"` / `config.core has unknown property "X"` | 拼写错误或多余键 | 配置只接受契约字段；改名或删除 |
| `X must be a positive integer` / `non-negative integer` / `finite number` | 数值类型/范围非法 | 字符与卡片数为正整数（linkCount 可 0）、比例为有限数 |
| `core.softRatio must be < core.hardRatio` 等比例错误 | 比例关系不满足 | 需要 `0<softRatio<hardRatio<1` |
| `spark.inlineMaxChars (N) must be <= spark.maxChars (M)` | 附件门槛超上限 | 调整 spark 参数 |
| `spark.seedCount + spark.linkCount (N) must be <= spark.maxCards (M)` | 3+2≤5 类约束 | 调整卡片数量 |
| `derived softAt (N) must be <= core.targetChars (M)` / `targetChars must be < derived hardAt` / `hardAt must be < hardCapChars` | 水位链断裂 | 按公式重算四档：softAt≤target<hardAt<cap |
| `renderL1 input is missing required property "X"` / `has unknown property "X"` | 选项对象字段不全/多余，或字段只在原型链上 | 严格传 `{coreText, topics}`，字段必须是自有属性 |
| `X must be a plain object, got undefined/Date/…`（含 `topics[N]`） | 稀疏数组孔、显式 undefined/null、或非普通记录对象 | topics 数组逐位校验：补齐条目或修复来源；`Object.create(原型)` 传参不被接受 |
| `coreText must be a string` / `topics must be an array` | 参数类型错误 | 检查调用点 |
| `duplicate topic key "K"` | renderL1 收到未去重列表 | 先过 `selectVisibleTopics` 再渲染 |
| `duplicate topic key "K" within scope "S"` | 同一 scope 内同 key 两份 | 存储层数据错误，检查文件层（B） |
| `summary is N UTF-16 chars, max is 60` | 摘要超限（emoji 计 2） | 压缩摘要；注意 UTF-16 而非字节数 |
| `summary must not contain line breaks` | 摘要含 \n/\r | 摘要必须是单行 |
| `title must be a non-empty string` / `revision must be a non-empty string` / `updated must be …` | Topic 元数据缺失或类型错误 | 按 INTERFACE.md §4 补齐 |
| `X: scopeId must be a non-empty string` / `must not contain control characters` | scopeId 非法 | scopeId 来自可信 session，检查来源 |
| `currentText must be a string` / `candidateText must be a string`（evaluateMutation） | 文本参数类型错误 | policy 接口只收字符串 |

## 行为类"异常"速查（不是 bug 的情况）

| 现象 | 解释 | 正确做法 |
| --- | --- | --- |
| `allowed=true` 但 `promotable=false` | 当前已超硬顶、候选仍在超限（如 11000→10500） | 允许写盘修复，但继续用上一份有效渲染，不得提升为 system（DESIGN §7.1） |
| 8999→9500 放行、9500→9501 拒绝 | 增长闸门语义：未到 9000 时允许首次跨入 ≤10000；到 9000 后禁止净增长 | 需要增长先做下沉（memory_demote） |
| 当前 >10000 时连等长改写都被拒（`repair-only`） | 超限态只允许净减少修复 | 先减到 ≤10000 再做其他改写 |
| 候选 >10000 从任何正常态直接拒绝（`over-hard-cap`） | 10000 是所有入口的最终防线 | 改写候选到 ≤10000 |
| emoji 长度"翻倍" | 一切按 UTF-16 码元计（`text.length`），emoji=2；UTF-8 bytes 仅诊断 | 用 chars 做预算，不要用 bytes |
| renderL1 对超限文本照样渲染 | 渲染器不做预算裁决，超限候选要先量出来才能比较 | 渲染后交 `evaluateMutation` 判定 |
| core 结尾有换行时出现三个连续 LF | 逐字保留正文 + 固定两 LF 连接，不做 trim | 正文内容归调用方管理 |
| 索引里出现 `- k [global] — `（尾部空） | 空串 summary 合法（契约只限 ≤60） | 如需禁止空摘要在 B/工具层加约束 |

## 诊断流程

1. `node test/core/diagnose.mjs` —— 12 项黄金自检（含 R1 孤立代理 / R2 稀疏数组 / R3 plain-object 回归）+ 200 专题渲染耗时参考，退出码 0/1。
2. `node --test test/core/*.test.mjs` —— 全量 91 用例（keys/config/topics/render/budget/integration）。
3. 仍异常时按上表定位模块：key → `src/core/keys.mjs`；配置 → `config.mjs`；渲染/索引 → `render.mjs`；水位 → `budget.mjs`；可见性/元数据 → `topics.mjs`。
4. 涉及 B/C 集成时先核对本表"跨 slot 约定"：全局 scopeId 字面量为 `"global"`；policy 必须传完整渲染文本。
