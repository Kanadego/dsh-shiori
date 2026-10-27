// Shiori P0-CORE · 内部错误与入参校验助手（非公共契约导出）。
// 契约要求：错误一律为带稳定 code 的 Error（INVALID_INPUT 等），
// 不静默截断、不自动以空字符串/零掩盖错误。
//
// 控制对象（选项/配置）必须是“普通记录对象”：原型为 Object.prototype
// 或 null。Date/Map/Set/类实例以及仅靠原型链携带字段的对象一律拒绝，
// 必填字段按 own-property 判定（防原型继承与 Object.prototype 污染）。

export function fail(code, message) {
  const error = new Error(message);
  error.name = "ShioriError";
  error.code = code;
  throw error;
}

// 普通记录对象判定：{}、字面量、Object.create(null) 为真；
// 数组、Date、Map、Set、类实例、Object.create(otherObject) 为假。
export function isPlainRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

// 人类可读的类型名，用于错误消息（含构造名以便定位 Date/Map 等）。
export function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    if (value.constructor && typeof value.constructor.name === "string") {
      return value.constructor.name;
    }
    return "object";
  }
  return typeof value;
}

// 值的简短展示：字符串加引号，其余转字符串。
export function show(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return String(value);
}

export function requireObject(value, name) {
  if (!isPlainRecord(value)) {
    fail("INVALID_INPUT", `${name} must be a plain object, got ${describe(value)}`);
  }
  return value;
}

// 选项对象严格校验：不接受未知属性（防拼写错误），必填属性必须为
// 自有属性（own-property）——仅存在于原型链上的字段不算数。
// 属性存在但值为 undefined 交给后续类型检查报更准确的错误。
export function requireExactKeys(value, name, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail("INVALID_INPUT", `${name} has unknown property "${key}" (allowed: ${keys.join(", ")})`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("INVALID_INPUT", `${name} is missing required property "${key}"`);
    }
  }
  return value;
}
