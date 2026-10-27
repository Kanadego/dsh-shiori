// front-matter 严格子集：序列化/解析往返、非法格式显式失败。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { serializeTopicFile, parseTopicFile, parseLegacyMarkdown } from '../../src/storage/frontmatter.mjs';
import { topicRawText } from './helpers.mjs';

const META = {
  key: 'alpha',
  title: '标题 ✨',
  summary: '摘"要"带引号',
  updated: '2026-10-24T12:00:00.000Z',
  scopeId: 'amber',
};

describe('serialize → parse 往返', () => {
  it('unicode/引号/换行转义正确，body 逐字节保留', () => {
    const body = '第一行\r\n带 "引号" 与 \\ 反斜杠\n🔥\n';
    const buf = serializeTopicFile(META, body);
    const parsed = parseTopicFile(buf);
    assert.equal(parsed.hasFrontMatter, true);
    for (const [k, v] of Object.entries(META)) {
      assert.equal(parsed.meta[k], v, `meta.${k}`);
    }
    assert.equal(parsed.body, body);
    // 双引号标量是合法 YAML/JSON
    const head = buf.toString('utf8').split('---\n')[1];
    for (const line of head.trim().split('\n')) {
      assert.match(line, /^[a-zA-Z]+: ".*"$/);
    }
  });

  it('空 body 合法', () => {
    const parsed = parseTopicFile(serializeTopicFile(META, ''));
    assert.equal(parsed.body, '');
  });

  it('空 summary 合法（R7：区分字段缺失与空值）', () => {
    const parsed = parseTopicFile(serializeTopicFile({ ...META, summary: '' }, 'x'));
    assert.equal(parsed.meta.summary, '');
    // 字段缺失仍然拒绝
    const missing = '---\nkey: "a"\ntitle: "t"\nupdated: "u"\nscopeId: "g"\n---\nb';
    assert.throws(() => parseTopicFile(Buffer.from(missing, 'utf8')), (e) => e.code === 'INVALID_STATE');
  });

  it('孤立代理码元：序列化与解析双侧拒绝（R5/R6）', () => {
    // 写入侧 = INVALID_INPUT；读取侧（已落盘的不可无损数据）= INVALID_STATE
    assert.throws(() => serializeTopicFile({ ...META, title: 'a\uD800b' }, 'x'),
      (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => serializeTopicFile(META, 'body\uD800'),
      (e) => e.code === 'INVALID_INPUT');
    // 文件里以 JSON 转义形式出现的孤立代理（合法 UTF-8 字节、解码后不可无损再编码）
    const text = '---\nkey: "a"\ntitle: "\\uD800"\nsummary: "s"\nupdated: "u"\nscopeId: "g"\n---\nb';
    assert.throws(() => parseTopicFile(Buffer.from(text, 'utf8')), (e) => e.code === 'INVALID_STATE');
  });

  it('非法 UTF-8 字节（61 C3 28）显式 INVALID_STATE，不静默替换（R6）', () => {
    assert.throws(() => parseTopicFile(Buffer.from([0x61, 0xc3, 0x28])),
      (e) => e.code === 'INVALID_STATE');
  });
});

describe('解析严格性（不支持格式明确失败）', () => {
  it('BOM → INVALID_STATE', () => {
    const buf = serializeTopicFile(META, 'x');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
    assert.throws(() => parseTopicFile(bom), (e) => e.code === 'INVALID_STATE');
  });

  it('缺闭合 --- → INVALID_STATE', () => {
    const text = '---\nkey: "a"\ntitle: "t"\nsummary: "s"\nupdated: "u"\nscopeId: "g"\n正文没有闭合';
    assert.throws(() => parseTopicFile(Buffer.from(text, 'utf8')), (e) => e.code === 'INVALID_STATE');
  });

  it('块列表/嵌套 map → INVALID_STATE', () => {
    const text = '---\nkey: "a"\ntags:\n  - one\n  - two\n---\nbody';
    assert.throws(() => parseTopicFile(Buffer.from(text, 'utf8')), (e) => e.code === 'INVALID_STATE');
  });

  it('plain 标量含 ": " → INVALID_STATE；简单 plain 标量可用', () => {
    assert.throws(() => parseTopicFile(Buffer.from(
      '---\nkey: a\ntitle: t: x\nsummary: s\nupdated: u\nscopeId: g\n---\nb', 'utf8',
    )), (e) => e.code === 'INVALID_STATE');
    const ok = parseTopicFile(Buffer.from(
      '---\nkey: a\ntitle: 纯文本标题\nsummary: s\nupdated: u\nscopeId: g\n---\nb', 'utf8',
    ));
    assert.equal(ok.meta.title, '纯文本标题');
  });

  it('重复字段 / 缺必填字段 → INVALID_STATE', () => {
    assert.throws(() => parseTopicFile(Buffer.from(
      '---\nkey: "a"\nkey: "b"\ntitle: "t"\nsummary: "s"\nupdated: "u"\nscopeId: "g"\n---\nb', 'utf8',
    )), (e) => e.code === 'INVALID_STATE');
    assert.throws(() => parseTopicFile(Buffer.from(
      '---\nkey: "a"\ntitle: "t"\nsummary: "s"\nupdated: "u"\n---\nb', 'utf8',
    )), (e) => e.code === 'INVALID_STATE');
  });

  it('无 front-matter → hasFrontMatter:false（legacy 分支）', () => {
    const parsed = parseTopicFile(Buffer.from('# 标题\n正文', 'utf8'));
    assert.equal(parsed.hasFrontMatter, false);
  });

  it('CRLF 文件：front-matter 行尾 \\r 被剥离，body 原样保留 CRLF', () => {
    const text = '---\r\nkey: "a"\r\ntitle: "t"\r\nsummary: "s"\r\nupdated: "u"\r\nscopeId: "g"\r\n---\r\nbody1\r\nbody2';
    const parsed = parseTopicFile(Buffer.from(text, 'utf8'));
    assert.equal(parsed.meta.key, 'a');
    assert.equal(parsed.body, 'body1\r\nbody2');
  });
});

describe('legacy Markdown 推导', () => {
  it('title 取首个 # 标题，summary 取首个非空正文行，不截断', () => {
    const r = parseLegacyMarkdown(Buffer.from('# 长标题\n\n这是一段非常长的摘要行'.padEnd(200, 'x') + '\n正文', 'utf8'));
    assert.equal(r.title, '长标题');
    assert.ok(r.summary.length > 60); // 不截断，影子报告如实反映
    assert.equal(r.body, '# 长标题\n\n这是一段非常长的摘要行'.padEnd(200, 'x') + '\n正文');
  });

  it('topicRawText 夹具与序列化器解析一致（测试工具自检）', () => {
    const raw = topicRawText({ key: 'k1', scopeId: 'amber', body: 'B' });
    const parsed = parseTopicFile(Buffer.from(raw, 'utf8'));
    assert.equal(parsed.meta.key, 'k1');
    assert.equal(parsed.body, 'B');
  });
});
