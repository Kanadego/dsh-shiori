# AGENTS.md — dsh-shiori

> Quick-reference guide for AI coding agents working in or operating `dsh-shiori` (v0.3.0).
> For user-facing quickstart see `README.md`; for full usage and install details see `docs/USAGE-GUIDE.md` and `docs/plugin/INSTALL.md`.

---

## 1. What This Project Is

`dsh-shiori` is a four-layer long-term memory plugin for **DeepSeek Harness (DSH)** (`>=0.2.1-rc.2 <0.3.0`, Node `>=24`, pure ESM JavaScript `.mjs`):

| Layer | Name | Prompt Injection Behavior | Storage under `dataRoot/<scope>/` |
|---|---|---|---|
| **L0** | Persona Card (`soul_*`) | Always resident at the top of the system prompt | `personas/<name>.md` (or `soul.md`) |
| **L1** | Core + Derived Index | Always resident every turn; **prompt-cache stable** within a turn | `core.md` + auto-derived 1-line index of `topics/*.md` |
| **L2** | Spark Cards (`spark_*`) | **Zero cost when silent**; injected as a turn attachment only when user text hits `triggers` (literal or optional local semantic recall) | `sparks.jsonl` + `semantic.index.json` |
| **L3** | Topic Files (`topic_*`) | Only 1-line summary in L1; full Markdown body loaded on demand via `memory_read(topic)` | `topics/<key>.md` |

### Scope Rules
- **L1 `core` uses Fallback (not merge)**: When an active persona scope (e.g. `amber`) has its own `core.md`, the `global` `core.md` is **not** injected.
- **L3 `topics` use Merge + Shadow**: `global` and active-persona topic indexes are merged into L1; if both have the same key, the active persona shadows `global`.
- **L1 Budget**: Derived solely from `hardCapChars` (default `14000` → `softChars = 9800`, `hardChars = 12600`). The derived topic index and `core.md` share this budget, with the index taking priority.

---

## 2. How to Use the 16 Agent Tools

### 2.1 L0 Persona Card (2 tools)
- `soul_read()` → returns `{ exists, persona, content, revision, stale }`.
- `soul_update({ content, operationId? })` → CAS-protected replacement of the active persona card; takes effect on the next turn.

### 2.2 L1 Core & L3 Topics (8 tools)
- `memory_read({ topic? })` → omit `topic` to read full rendered L1 (`core` + derived index) and its `revision`; pass `topic: "<key>"` to read an L3 topic's full Markdown body.
- `core_write({ content, expectedRevision, operationId? })` → replace L1 `core.md` body (do **not** include the derived topic index in `content`; pass `revision` from `memory_read()`).
- `memory_append({ section, content, topic?, operationId? })` → append a dated section to L1 `core` (omit `topic`) or an existing L3 topic.
- `memory_rewrite({ content, topic?, operationId? })` → replace L1 `core` or an existing L3 topic body while preserving topic front-matter.
- `topic_create({ topic, title, summary, operationId? })` → create a new L3 topic file (`summary` must be a single line, `<= 60` UTF-16 code units recommended).
- `topic_append({ topic, section, content, operationId? })` → append a dated section to an existing L3 topic.
- `memory_list_topics()` → list all visible topics with character/byte counts and revisions.
- `memory_search({ query, limit?, includeArchived? })` → lexical keyword search across visible topics (archived topics return summary-only entries with `state: "archived"`).

### 2.3 L2 Spark Atomic Cards (6 tools)
- `spark_save({ title, content, triggers, vitality, summary?, entities?, links?, operationId? })` → save an atomic memory card (`50–150` chars recommended). Give `3–5` distinct natural wake phrases in `triggers`; `vitality` is `"evergreen"` or `"ephemeral"`.
- `spark_read({ id })` → read full text and metadata of one spark card by ID.
- `spark_update({ id, patch, expectedRevision?, operationId? })` → CAS patch of `title` / `summary` / `content` / `triggers` / `entities` / `links` / `vitality`.
- `spark_forget({ id, mode: "archive" | "supersede", replacementId?, expectedRevision?, operationId? })` → retire a spark card from active trigger matching.
- `spark_feedback({ id, used, sourceEventId?, operationId? })` → record explicit usefulness feedback for a delivered spark.
- `spark_graph()` → returns active spark graph node/edge scale summary and panel handle.

---

## 3. Build, Test & Package Verification Commands

`dsh-shiori` is written in pure ESM (`.mjs`) with zero build step. Run from repo root (`D:/AIagent/shiori`):

```bash
npm test                 # Run the full Node test suite across all 13 test directories
npm run test:p5          # Run plugin / RPC / config tests (test/plugin/*.test.mjs)
npm run test:integration # Run service & integration tests
npm run test:p1          # Run runtime / completion / acceptance tests
npm run test:p3          # Run organize queue & executor tests
npm run test:p4          # Run forgetting / decay tests
npm run verify:package   # Verify package exports, files whitelist, and tarball integrity
```

---

## 4. Codebase Map & Architectural Invariants

- `index.mjs` — Cordis plugin entry (`name = "shiori"`, `inject = ["tools", "systemPrompt"]`, named `Config` export, `apply(ctx, config)` with strict reverse-order teardown).
- `src/core/` — L1 budget math (`budget.mjs`), config validation (`config.mjs`), L1+index renderer (`render.mjs`), topic parser (`topics.mjs`).
- `src/storage/` — Atomic file store (`store.mjs`), lockfile (`lockfile.mjs`), two-phase commit journal (`journal.mjs`), front-matter parser (`frontmatter.mjs`).
- `src/sparks/` — L2 store (`store.mjs`), literal & entity spread matching (`match.mjs`), semantic recall (`semantic-recall.mjs`), turn attachment delivery (`delivery.mjs`), graph projection (`graph.mjs`).
- `src/organize/` & `src/forgetting/` — L1 water-level analysis, organize proposal queue/executor, time-decay scoring, and cold archive search.
- `src/semantic/` — Optional local embedding engine (`@huggingface/transformers`, default `Xenova/bge-small-zh-v1.5`, `provider: "none" | "local"`).
- `src/plugin/` — Schemastery config & root verification (`config.mjs`), plugin lifecycle controller (`controller.mjs`), 16 tool schemas & TypeRT descriptors (`tool-schemas.mjs`, `typert-descriptors.mjs`), Web UI RPC (`client-rpc.mjs`).
- `client/index.js` — Browser Web UI client bundle (water-level bar, spark knowledge graph, organize queue review, topic browser).

### Hard Invariants (Do Not Break)

1. **Separate `dataRoot` and `stateRoot`**: In active mode, both `dataRoot` and `stateRoot` must be explicit, canonical, non-nested absolute paths (`verifyPluginRoots` in `src/plugin/config.mjs`).
2. **CAS & Idempotency**: Every mutating operation goes through `service.mutate` with revision CAS and `operationId` idempotency. Never bypass the storage layer to overwrite files directly while the service is live.
3. **Prompt Cache Stability**: L0 and L1 sections injected via `systemPrompt` must remain byte-identical within a turn; dynamic per-turn recalls (L2 sparks) are delivered exclusively as turn attachments (`src/sparks/delivery.mjs`).
4. **DSH Value Schema DSL Rules (`src/plugin/tool-schemas.mjs`)**: Every `object` schema must explicitly declare `additionalProperties: true | false`; required fields use property-level `required: true` (no top-level `required` array); unions use `oneOf`.
