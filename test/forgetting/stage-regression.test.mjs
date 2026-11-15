// 真实旧回归（stage 生产位置运行 P0-P3 测试）——发版门禁层。
//
// 自 test/forgetting/store.test.mjs 拆出（测试分层，0.4-REVIEW 附录 C 杠杆 1）：
// 三条用例逐字原样搬移，断言一句未改。默认 `npm test` 不跑本文件
// （scripts/run-tests.mjs dev 层显式排除 forgetting/stage-regression.test.mjs），
// `npm run test:release` 才会执行——stage 壳是为了验证 file: 依赖 hoisted
// 复制布局（S9#1 债）下插件仍工作，布局变化频率低，收口/发版全量跑即可。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(HERE, '../..'); // 当前项目根（test/forgetting → 上两级）

let stage = null;

/** 运行 stage 内旧测试（真实子进程 node --test）。
 * 须剥离子进程的 NODE_TEST_CONTEXT/NODE_TEST_TMP_DIR：否则父测试运行器
 * 会在子进程里留下「递归测试」标记，node --test 会跳过执行并只告警。 */
function runNodeTest(files, timeoutMs = 300_000) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_TMP_DIR;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: stage, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function stageTestFiles(dirs) {
  const files = [];
  for (const d of dirs) {
    const abs = path.join(stage, 'test', d);
    for (const e of (await fsp.readdir(abs)).sort()) {
      if (e.endsWith('.test.mjs')) files.push(path.join(abs, e));
    }
  }
  return files;
}

function tapCounts(out) {
  const grab = (re) => Number((out.match(re) || [])[1] ?? -1);
  return { tests: grab(/^# tests (\d+)$/m), pass: grab(/^# pass (\d+)$/m), fail: grab(/^# fail (\d+)$/m) };
}

describe('真实旧回归（stage 生产位置运行 P0-P3 测试）', () => {
  before(async () => {
    stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-p4n-stage-'));
    for (const name of ['src', 'test']) {
      await fsp.cp(path.join(WORK, name), path.join(stage, name), { recursive: true });
    }
    await fsp.copyFile(path.join(WORK, 'package.json'), path.join(stage, 'package.json'));
    const fixture = 'test/fixtures/frozen/G/a2-226d3f0e-77ea-4a4c-b097-ad6483ebc806/files/src/sparks/store.mjs';
    await fsp.mkdir(path.dirname(path.join(stage, fixture)), { recursive: true });
    await fsp.copyFile(path.join(WORK, fixture), path.join(stage, fixture));
  });

  after(async () => {
    if (stage) {
      await fsp.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      stage = null;
    }
  });

  // ------------------------------------------------------------------
  it('定向：stage test/sparks 全套通过（旧 API、LOCK_BUSY 跨进程锁、损坏 fail-closed）', async () => {
    const files = await stageTestFiles(['sparks']);
    const { code, out, err } = await runNodeTest(files, 240_000);
    const counts = tapCounts(out);
    assert.equal(code, 0, `旧 sparks 回归失败：\n${out.slice(-4000)}\n${err.slice(-2000)}`);
    assert.ok(counts.tests > 0 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
  });

  it('定向：stage test/organize 全套通过（P3 方法保留 + G a2 冻结 loader 对照）', async () => {
    const files = await stageTestFiles(['organize']);
    const { code, out, err } = await runNodeTest(files, 240_000);
    const counts = tapCounts(out);
    assert.equal(code, 0, `旧 organize 回归失败：\n${out.slice(-4000)}\n${err.slice(-2000)}`);
    assert.ok(counts.tests > 0 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
  });

  it('全量：stage npm test 等价（P0-P3 全部套件真实运行）', async () => {
    const dirs = ['core', 'host', 'storage', 'service', 'integration', 'runtime', 'completion', 'acceptance', 'sparks', 'organize'];
    const files = await stageTestFiles(dirs);
    assert.ok(files.length >= 40, `stage 测试文件数量异常：${files.length}`);
    const { code, out, err } = await runNodeTest(files, 420_000);
    const counts = tapCounts(out);
    assert.equal(code, 0, `全量旧回归失败：\n${out.slice(-6000)}\n${err.slice(-2000)}`);
    assert.ok(counts.tests > 700 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
  });
});
