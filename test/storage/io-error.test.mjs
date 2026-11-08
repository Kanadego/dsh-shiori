// A4（P2-4）storage 层文件系统 IO 失败归口：底层 fs 错误必须包装为
// StorageError（code=IO_ERROR，details.ioCode 保留原始 errno，cause 保留原始错误），
// 与 sparks 层 wrapIoError 约定一致，不再以裸 fs 错误（name="Error"）冒泡。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StorageError } from '../../src/storage/index.mjs';
import { readFileOrNull, writeFileSynced, atomicReplace } from '../../src/storage/fsutil.mjs';

/** 制造一个「父路径是普通文件」的夹具：其下任何读/写/改名都会得到 ENOTDIR。 */
async function blockedPath(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-io-err-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  const blocker = path.join(dir, 'blocker');
  await fsp.writeFile(blocker, Buffer.from('i am a file', 'utf8'));
  return { dir, blocked: path.join(blocker, 'child.txt') };
}

describe('A4 fsutil IO 错误包装', () => {
  it('readFileOrNull 非 ENOENT 失败 → StorageError/IO_ERROR + ioCode + cause', async (t) => {
    // 对目录路径 readFile 在各平台稳定得到 EISDIR（非 ENOENT），触发非 ENOENT 分支
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-io-err-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
    await assert.rejects(
      readFileOrNull(dir),
      (err) => {
        assert.ok(err instanceof StorageError, `必须为 StorageError，收到 name=${err.name}`);
        assert.equal(err.code, 'IO_ERROR');
        assert.equal(err.details.ioCode, 'EISDIR');
        assert.ok(err.cause, 'cause 必须保留原始 fs 错误');
        assert.equal(err.cause.code, 'EISDIR');
        return true;
      },
    );
  });

  it('readFileOrNull ENOENT 仍返回 null，不受包装影响', async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-io-err-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
    assert.equal(await readFileOrNull(path.join(dir, 'absent.txt')), null);
  });

  it('writeFileSynced open 失败 → StorageError/IO_ERROR', async (t) => {
    const { blocked } = await blockedPath(t);
    await assert.rejects(
      writeFileSynced(blocked, Buffer.from('x', 'utf8')),
      (err) => {
        assert.ok(err instanceof StorageError, `必须为 StorageError，收到 name=${err.name}`);
        assert.equal(err.code, 'IO_ERROR');
        // ioCode 平台相关（POSIX ENOTDIR / Windows ENOENT），断言原始 errno 已保留即可
        assert.ok(typeof err.details.ioCode === 'string' && err.details.ioCode.length > 0);
        assert.equal(err.cause?.code, err.details.ioCode);
        return true;
      },
    );
  });

  it('atomicReplace rename 失败 → StorageError/IO_ERROR', async (t) => {
    const { blocked } = await blockedPath(t);
    await assert.rejects(
      atomicReplace(blocked, Buffer.from('x', 'utf8')),
      (err) => {
        assert.ok(err instanceof StorageError);
        assert.equal(err.code, 'IO_ERROR');
        // Windows 上 ENOTDIR 由 tmp 写入（open）阶段抛出，POSIX 上可能在 rename 阶段；
        // 两处都已归口为 IO_ERROR，这里只断言 code 与 cause 保留
        assert.ok(err.cause, 'cause 必须保留');
        return true;
      },
    );
  });
});
