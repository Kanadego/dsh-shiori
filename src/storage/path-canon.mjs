// Shiori 0.4-S2（#e8a569）· 路径规范化的唯一来源。
//
// src/plugin/config.mjs（插件根校验、scope 根比较）与 src/storage/purge.mjs
// （删除安全判断）共用本模块——此前两边各存一份语义相同的实现，只改一边就会
// 静默分叉：purge 的「同根 / 嵌套」比较一旦与 config 口径不一致，后果是误删
// 或误拒。实现只在这里维护，调用方各自注入错误类型。
//
// 纯函数层：只依赖 node:path / node:fs，不 import 插件层任何东西。

import { realpathSync } from "node:fs";
import { basename, dirname, join, normalize, sep } from "node:path";

export const CASE_INSENSITIVE_FS = process.platform === "win32";

// 把路径折算成可比较形式：normalize（统一分隔符、折叠重复、收缩 ..）后去掉全部
// 尾部分隔符（盘根折叠为裸盘符，POSIX 根 "/" 折叠为 ""），win32 再统一小写。
// 此后「相等 / 嵌套 / 不相交」的判定只在这一种 canonical 形状上进行，盘根、
// 混排分隔符、尾随分隔符不再有特例。
// 0.4 P4 返工（reviewer）：scope.mjs 的 rootsSource 自洽校验按同一口径比较默认根，
// 两处必须同源——导出复用，不许在 scope 里再写一份相似实现。
export function comparableRoot(value) {
  let normalized = normalize(value);
  if (CASE_INSENSITIVE_FS) normalized = normalized.toLowerCase();
  while (normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// 沿已存在的最近祖先做 realpath，再拼回不存在尾部：得到「按当前文件系统解析」
// 的绝对路径。非 ENOENT 的 fs 错误交给 onError(message) 工厂包装（调用方决定
// 错误类型）；不传 onError 时抛普通 Error 并带 code "INVALID_INPUT"（config 原行为）。
export function resolveWithLinks(target, onError) {
  let current = target;
  const tail = [];
  for (;;) {
    try {
      const resolved = realpathSync(current);
      return tail.length === 0 ? resolved : join(resolved, ...tail);
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        const message = `cannot resolve "${target}": ${String(error.message || error)}`;
        if (typeof onError === "function") throw onError(message);
        const wrapped = new Error(message);
        wrapped.code = "INVALID_INPUT";
        throw wrapped;
      }
      const parent = dirname(current);
      if (parent === current) return target; // 到盘根仍不存在：按字面路径返回
      tail.unshift(basename(current));
      current = parent;
    }
  }
}
