// 真实旧回归（stage 生产位置运行 P0-P3 测试）——发版门禁层。
//
// 自 test/forgetting/store.test.mjs 拆出（测试分层，0.4-REVIEW 附录 C 杠杆 1），
// 0.4 分层收口二期从 test/forgetting/stage-regression.test.mjs 整体迁入 test/release/
// （EXCLUDE_FROM_DEV 手维护清单随之删除，慢测试靠「放进 test/release/ 目录」归层）：
// 三条用例逐字原样搬移，断言一句未改。默认 `npm test`（dev 层）不跑本文件，
// `npm run test:release` 才会执行——stage 壳是为了验证 file: 依赖 hoisted
// 复制布局（S9#1 债）下插件仍工作，布局变化频率低，收口/发版全量跑即可。
// stage 搭台三件套（runNodeTest / stageTestFiles / tapCounts）已抽至
// test/fixtures/stage.mjs 共享脚手架（与 test/forgetting/store.test.mjs 共用）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProjectStage, removeStage, collectStageTestFiles, runNodeTestIn, tapCounts,
} from '../fixtures/stage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(HERE, '../..'); // 当前项目根（test/release → 上两级）

let stage = null;

describe('真实旧回归（stage 生产位置运行 P0-P3 测试）', () => {
  before(async () => {
    stage = await createProjectStage({ prefix: 'shiori-p4n-stage-' });
  });

  after(async () => {
    await removeStage(stage);
    stage = null;
  });

  // ------------------------------------------------------------------
  it('定向：stage test/sparks 全套通过（旧 API、LOCK_BUSY 跨进程锁、损坏 fail-closed）', async () => {
    const files = await collectStageTestFiles(stage, ['sparks']);
    const { code, out, err } = await runNodeTestIn(stage, files, 240_000);
    const counts = tapCounts(out);
    assert.equal(code, 0, `旧 sparks 回归失败：\n${out.slice(-4000)}\n${err.slice(-2000)}`);
    assert.ok(counts.tests > 0 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
  });

  it('定向：stage test/organize 全套通过（P3 方法保留 + G a2 冻结 loader 对照）', async () => {
    const files = await collectStageTestFiles(stage, ['organize']);
    const { code, out, err } = await runNodeTestIn(stage, files, 240_000);
    const counts = tapCounts(out);
    assert.equal(code, 0, `旧 organize 回归失败：\n${out.slice(-4000)}\n${err.slice(-2000)}`);
    assert.ok(counts.tests > 0 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
  });

  it('全量：stage npm test 等价（P0-P3 全部套件真实运行）', async () => {
    const dirs = ['core', 'host', 'storage', 'service', 'integration', 'runtime', 'completion', 'acceptance', 'sparks', 'organize'];
    const files = await collectStageTestFiles(stage, dirs);
    assert.ok(files.length >= 40, `stage 测试文件数量异常：${files.length}`);
    const { code, out, err } = await runNodeTestIn(stage, files, 420_000);
    const counts = tapCounts(out);
    assert.equal(code, 0, `全量旧回归失败：\n${out.slice(-6000)}\n${err.slice(-2000)}`);
    assert.ok(counts.tests > 700 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
  });
});
