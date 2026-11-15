// 选卡热提交：宿主 settings 写入后只更新 volatile 引用、不重载插件；
// 这里验证 pinScope 每次实时解包，会话进行中切人设卡立即生效。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateControllerSettings, pinScope, readLiveRefs, liveSettingsForScope,
} from "../../src/plugin/scope.mjs";

const WRITE = Symbol.for("cosmokit.volatile.write");

/** 造一个宿主形态的 volatile 引用（鸭子类型与 config.mjs unwrapVolatile 一致）。 */
function volatileRef(initial) {
  let current = initial;
  return {
    get: () => current,
    set: (next) => { current = next; },
    [WRITE]: () => {},
  };
}

function settingsWith(refs, raw = {}) {
  return Object.freeze({
    ...validateControllerSettings({ mode: "shadow", allowActive: false, ...raw }),
    liveRefs: readLiveRefs(refs),
  });
}

test("readLiveRefs：只认带 get() 的引用，普通值一律记 null", () => {
  const refs = readLiveRefs({
    defaultPersona: volatileRef("amber"),
    sessionPersonas: ["not-a-ref"],
    workspacePersonas: null,
  });
  assert.equal(typeof refs.defaultPersona.get, "function");
  assert.equal(refs.sessionPersonas, null);
  assert.equal(refs.workspacePersonas, null);
  assert.equal(readLiveRefs(null).defaultPersona, null);
  assert.equal(readLiveRefs(undefined).defaultPersona, null);
});

test("liveSettingsForScope：引用里的最新值覆盖装配期快照", () => {
  const defaultRef = volatileRef("amber");
  const settings = settingsWith({ defaultPersona: defaultRef }, { defaultPersona: "amber" });
  assert.equal(liveSettingsForScope(settings).defaultPersona, "amber");
  defaultRef.set("momo");
  assert.equal(liveSettingsForScope(settings).defaultPersona, "momo");
});

test("pinScope：切卡后同一会话的下一次调用立即换 scope（无需重启）", () => {
  const defaultRef = volatileRef("amber");
  const settings = settingsWith({ defaultPersona: defaultRef }, { defaultPersona: "amber" });
  const before = pinScope({ settings, sessionId: "s-live", generation: 1, source: "tool-exec" });
  assert.equal(before.scopeId, "amber");
  defaultRef.set("momo");
  const after = pinScope({ settings, sessionId: "s-live", generation: 1, source: "tool-exec" });
  assert.equal(after.scopeId, "momo");
  assert.equal(after.persona, "momo");
});

test("pinScope：sessionPersonas 热值优先于 defaultPersona；workspace 走最长前缀", () => {
  const sessionRef = volatileRef([{ sessionId: "s-1", persona: "beta" }]);
  const workspaceRef = volatileRef([{ workspace: "D:/work/proj", persona: "kappa" }]);
  const settings = settingsWith(
    { sessionPersonas: sessionRef, workspacePersonas: workspaceRef },
    { defaultPersona: "amber" },
  );
  assert.equal(pinScope({ settings, sessionId: "s-1", generation: 0, source: "tool-exec" }).scopeId, "beta");
  assert.equal(pinScope({ settings, sessionId: "s-2", workspace: "D:/work/proj/src", generation: 0, source: "tool-exec" }).scopeId, "kappa");
  assert.equal(pinScope({ settings, sessionId: "s-2", generation: 0, source: "tool-exec" }).scopeId, "amber");
});

test("pinScope：引用抛错或热值非法 → 回落装配期快照，不拒绝请求", () => {
  const brokenRef = { get: () => { throw new Error("boom"); }, [WRITE]: () => {} };
  const badRef = volatileRef("");
  const fallback = settingsWith({ defaultPersona: brokenRef }, { defaultPersona: "amber" });
  assert.equal(pinScope({ settings: fallback, sessionId: "s-x", generation: 0, source: "tool-exec" }).scopeId, "amber");
  const invalid = settingsWith({ defaultPersona: badRef }, { defaultPersona: "amber" });
  assert.equal(pinScope({ settings: invalid, sessionId: "s-x", generation: 0, source: "tool-exec" }).scopeId, "amber");
});
