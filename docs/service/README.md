# Service adapter

src/service/index.mjs exports createShioriService({ root, activeScopeId, config, personaAdapter, now }). root must be absolute and explicit; activeScopeId comes from the trusted host factory. There is no home/profile default. The adapter directly imports ../core/index.mjs and ../storage/index.mjs.

## Read contract

- readCore() returns the disk core body and an opaque service revision: { text, revision, scopeId }. It never returns the rendered index as writeable body.
- readCoreView() returns { text, body, revision, scopeId }; text is A.renderL1 over a single B snapshot, including the derived topic index; body is the disk core body without the index (write paths must use body — writing text back would persist the derived index). The revision token binds the rendered projection as well as its source and generation.
- readTopic(key) returns the visible Topic with body and an opaque service revision. Missing keys keep B's explicit NOT_FOUND behavior; this service does not create topics.
- listTopics() returns current visible Topics with opaque revisions. search(query) is lexical over visible topic key/title/summary/body and returns key/title/summary/scopeId/score; it is not semantic retrieval.
- readPersona() delegates to personaAdapter.read(), or returns { name: null, text: null } when no adapter is injected.

## Mutations

C sends core { kind: "core", text, expectedRevision } and topic { kind: "topic", key, text: body, expectedRevision, topic: { title?, summary?, updated? } }. For B, the service maps topic body and metadata into the single structured field:

    { kind: "topic", key, expectedRevision, topic: { title, summary, updated, body } }

Topic title/summary default to the metadata captured in the revision token; updated defaults to the token's issue timestamp, keeping operationId replays byte-for-byte stable. Explicit updated is preserved. Existing topics only are writable in P0. Seed test topics through B's storage API; C's topic_append requires an existing key.

Revision values returned by reads are opaque, base64url-encoded service tokens with a digest, bound to canonical root, active scope, resource kind/key, visible source scope/revision, active write target revision, and snapshot generation. Core view tokens also bind the complete rendered view. They are CAS evidence, not authorization. Do not construct or parse them in callers. For active fallback from global, the token preserves global source revision while the B expectedRevision is null for the absent active target. Under the B root coordinator lock, service policy verifies the visible source is unchanged before B applies its active-target CAS and A's full rendered-view budget.

The storage API must expose reentrant withLock(fn) over the same canonical root so service can hold its coordinator across source validation and commit. B's durable journal remains the sole memory-write idempotency authority. The service does not inject a timestamp or new generation into B's operation identity on retry. B results are passed through with scope: activeScopeId added to each change for C's writeReceipt; this is the write destination, including copy-on-write shadowing from global.

Persona writes ({ kind: "persona", text, expectedRevision }) are forwarded unchanged to personaAdapter.commit(request), which must implement its own durable CAS/idempotency. No adapter means UNSUPPORTED. Persona plus memory in one request is rejected because the two stores cannot provide atomic cross-store commit.

## Checks

Focused tests: node --test test/service/integration.test.mjs. They use temporary directories and synthetic content only. They cover fallback first-write, manual edit and concurrent writer conflicts, rendered-index non-persistence and budget, active/global separation, stable replay, topic metadata and persona delegation. Storage is now merged with the independently reviewed guard-lock overlay. On 2026-10-24 the service tests passed 18/18 and real A/B/service/C bridge tests passed 5/5 within the root regression of 339/339. This is synthetic acceptance, not deployment or real-host outgoing-system validation.
