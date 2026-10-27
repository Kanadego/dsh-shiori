# 宿主形状兼容说明（2026-10-25 实机）

> 场景：把 Shiori 接进 DSH desktop profile 实机启动时撞到的**宿主 API 形状**问题。与 Shiori 自身逻辑无关，属插件外壳层适配。
> 实测环境：Windows，`@deepseek-ai/dsh-tools@0.2.1-rc.2`（DSH 0.2.1-rc.2），profile = `C:/Users/you/.dsh/profiles/desktop`。

## 1. `defineTool()` 必须传 `output: { schema, render }`

**现象**：注册工具时立刻抛

```
TypeError: Cannot read properties of undefined (reading 'render')
    at defineTool (...\.dsh\...\@deepseek-ai\dsh-tools\lib\index.js:842:36)
    at Object.registerTool (D:/work/shiori/src/host/dsh-adapter.mjs:231:51)
```

**判据**：`dsh-tools/lib/index.js:842` 无条件读 `const userRender = options.output.render;`，同一函数在 849 行还要 `valueSchemaSpecToJsonSchema(options.output.schema)`。所以 `output` 不是可选项——只给 `name / description / parameters / execute` 的老式形状会直接崩。

**修法**：

```js
await ctx.tool.register({
  name,
  description,
  parameters,            // 见下方注：property map，不是完整 JSON Schema
  isConcurrencySafe,
  execute,
  presentCall,
  output: {
    schema: { type: "object", additionalProperties: false, properties: {} },
    render: (_args, value) => [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? null) },
    ],
  },
});
```

**附加约束**：`output.schema` 走同一套 JSON Schema 子集编译器，`additionalProperties` 必须显式写出。
`{ type: "object" }` 会被拒：

```
JsonSchemaError: unsupported JSON schema: schema.additionalProperties must be explicitly true or false
```

## 2. 入参 `parameters` 的 `type` 不接受数组

**现象**：

```
JsonSchemaError: unsupported JSON schema: parameters.expectedRevision.type must be
string/number/integer/boolean/null/array/object/json, or use oneOf
```

（`expectedRevision` 是当时报错涉及的字段名，换别的字段名字段一样报。）

**修法**：多类型联合一律写 `oneOf`，`required` 保持原样：

```js
// 不行
expectedRevision: { type: ["string", "null"], required: true, description: "..." }
// 可以
expectedRevision: {
  oneOf: [{ type: "string" }, { type: "null" }],
  required: true,
  description: "...",
}
```

**同类待改点**（同一份代码里的其余残留，注册对应工具前都要改）：

- `D:/work/shiori/src/sparks/tools.mjs:220`
- `D:/work/shiori/src/sparks/tools.mjs:294`
- `D:/work/shiori/src/sparks/tools.mjs:334`

三处均为 `type: ["string", "number", "null"]` 形式的联合类型。

## 3. 已确认没有坑的两处（不必改）

- `parameters` 的形状是 **property map**：`{ [paramName]: { type, required, description } }`，不是完整 JSON Schema（没有外层 `type: "object"` / `properties`）。这点与 `dsh-soul-md@0.10.2` 一致。
- `ctx.systemPrompt.section({ name, order, text, interpolate })` 的 `text` **可以传函数**（延迟渲染），`dsh-soul-md` 的 `index.js:351` 就是 `text: renderPersona` 这种写法；`interpolate: false` 也是合法值。

## 4. 与 dsh-soul-md 同时挂载会撞名

shiori 的工具名 `soul_read` / `soul_update` / `memory_read` / `memory_search` / `memory_append` / `memory_rewrite` / `core_write` / `topic_append` / `memory_list_topics` 与 soul-md 完全重合。两个插件同时启用会被工具归属校验直接拒绝：

```
tool ownership conflict: ... already registered by another provider
(same-name tool must have exactly one provider; is soul-md still enabled?)
```

即同名工具必须全局只有一个提供者。要么不同时挂，要么改其中一方的名字。

## 附：建议的验证顺序

1. 先在一个只有 `@deepseek-ai/dsh-base` + 插件本身的空 profile 里 `dsh --profile <克隆> --dump-config`，确认装配链与 schema 能过编译器（EXIT=0、stderr 空）。
2. 再进真机 profile 启动，看工具是否出现在会话工具列表、section 是否注入。
3. 最后验 stop 干净（无残留工具、无挂起的 section）。

