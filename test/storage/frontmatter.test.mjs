// front-matter 严格子集：序列化/解析往返、非法格式显式失败。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { serializeTopicFile, parseTopicFile } from '../../src/storage/frontmatter.mjs';
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

describe('测试夹具自检', () => {
  it('topicRawText 夹具与序列化器解析一致（测试工具自检）', () => {
    const raw = topicRawText({ key: 'k1', scopeId: 'amber', body: 'B' });
    const parsed = parseTopicFile(Buffer.from(raw, 'utf8'));
    assert.equal(parsed.meta.key, 'k1');
    assert.equal(parsed.body, 'B');
  });
});

describe('archivedAt 归档标记（可选字段）', () => {
  it('有值时序列化输出 ISO 时间串，往返保留', () => {
    const meta = { ...META, archivedAt: '2026-11-07T00:00:00.000Z' };
    const buf = serializeTopicFile(meta, 'body');
    const text = buf.toString('utf8');
    assert.match(text, /^archivedAt: "2026-11-07T00:00:00\.000Z"$/m);
    const parsed = parseTopicFile(buf);
    assert.equal(parsed.meta.archivedAt, '2026-11-07T00:00:00.000Z');
  });

  it('空串/undefined/null 时整行省略（= 未归档，序列化为空时省略）', () => {
    for (const archivedAt of ['', undefined, null]) {
      const buf = serializeTopicFile({ ...META, archivedAt }, 'body');
      const text = buf.toString('utf8');
      assert.doesNotMatch(text, /^archivedAt:/m, `archivedAt=${String(archivedAt)}`);
      const parsed = parseTopicFile(buf);
      assert.equal(parsed.meta.archivedAt, undefined);
    }
    // 完全不带 archivedAt 的老文件形状不变
    assert.doesNotMatch(serializeTopicFile(META, 'body').toString('utf8'), /^archivedAt:/m);
  });

  it('非 ISO 时间串 → INVALID_INPUT', () => {
    assert.throws(() => serializeTopicFile({ ...META, archivedAt: '不是时间' }, 'b'),
      (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => serializeTopicFile({ ...META, archivedAt: 123 }, 'b'),
      (e) => e.code === 'INVALID_INPUT');
  });

  it('磁盘上有 archivedAt（含 plain 标量）可解析为普通字段', () => {
    const parsed = parseTopicFile(Buffer.from(
      '---\nkey: "a"\ntitle: "t"\nsummary: "s"\nupdated: "u"\nscopeId: "g"\narchivedAt: "2026-11-07T08:30:00.000Z"\n---\nb', 'utf8',
    ));
    assert.equal(parsed.meta.archivedAt, '2026-11-07T08:30:00.000Z');
  });
});

describe('0.5 A 线：retention / archiveOrigin 保留策略字段', () => {
  it('非默认值序列化输出枚举行，往返保留（round-trip）', () => {
    const meta = { ...META, retention: 'historical', archiveOrigin: 'auto-inactive' };
    const buf = serializeTopicFile(meta, 'body');
    const text = buf.toString('utf8');
    assert.match(text, /^retention: "historical"$/m);
    assert.match(text, /^archiveOrigin: "auto-inactive"$/m);
    const parsed = parseTopicFile(buf);
    assert.equal(parsed.retention, 'historical');
    assert.equal(parsed.archiveOrigin, 'auto-inactive');
    // 新字段不混入 meta 字符串记录（与 group/pinned 同款一等字段口径）
    assert.equal(parsed.meta.retention, undefined);
    assert.equal(parsed.meta.archiveOrigin, undefined);
    // 行位置在 archivedAt 之后、group 之前（写入顺序稳定）
    const order = text.split('\n').map((l) => l.split(':')[0]);
    assert.ok(order.indexOf('archivedAt') < order.indexOf('archiveOrigin'));
    assert.ok(order.indexOf('archiveOrigin') < order.indexOf('retention'));
  });

  it('缺省值/undefined/null/空串整行省略（老文件形状零变化），读取补默认值', () => {
    const variants = [
      META,
      { ...META, retention: undefined, archiveOrigin: undefined },
      { ...META, retention: null, archiveOrigin: null },
      { ...META, retention: 'standing', archiveOrigin: 'manual' },
      { ...META, retention: '', archiveOrigin: '' },
    ];
    for (const [i, meta] of variants.entries()) {
      const text = serializeTopicFile(meta, 'body').toString('utf8');
      assert.doesNotMatch(text, /^retention:/m, `variant ${i}: 默认/清除整行省略`);
      assert.doesNotMatch(text, /^archiveOrigin:/m, `variant ${i}: 默认/清除整行省略`);
      const parsed = parseTopicFile(Buffer.from(text, 'utf8'));
      assert.equal(parsed.retention, 'standing', `variant ${i}: 缺省读取补 standing`);
      assert.equal(parsed.archiveOrigin, 'manual', `variant ${i}: 缺省读取补 manual`);
    }
  });

  it('显式 retention:"standing" 属有意归一化：parse→rewrite 省略该行但语义不变（8-4 口径钉死）', () => {
    // 磁盘上手写了「显式 standing」：读取值仍是 standing，rewrite 会按缺省值
    // 归一化省略整行——这是拍板口径（信息不丢失：两形态读取等价），不是 bug。
    const explicitText = '---\nkey: "a"\ntitle: "t"\nsummary: "s"\nupdated: "u"\nscopeId: "g"\n'
      + 'retention: "standing"\n---\nb';
    const parsed = parseTopicFile(Buffer.from(explicitText, 'utf8'));
    assert.equal(parsed.retention, 'standing', '显式 standing 读取值不变');
    // rewrite：把解析出的完整字段回写（模拟 service append/rewrite 继承路径）
    const rewritten = serializeTopicFile({
      ...META, key: 'a', title: 't', summary: 's', updated: 'u', scopeId: 'g',
      retention: parsed.retention,
    }, 'b').toString('utf8');
    assert.doesNotMatch(rewritten, /^retention:/m, '显式 standing 经 rewrite 省略整行（有意归一化）');
    const reparsed = parseTopicFile(Buffer.from(rewritten, 'utf8'));
    assert.equal(reparsed.retention, 'standing', '重写后语义仍是 standing');
    // 对照组：同一路径上 historical 绝不能被抹掉（防「顺手省略所有 retention」的误修）
    const historical = serializeTopicFile({ ...META, retention: 'historical' }, 'b').toString('utf8');
    assert.match(historical, /^retention: "historical"$/m, '非缺省策略必须落盘');
  });

  it('旧文件（手工构造无新字段）读取补默认值且 meta 不被注入；已有 archivedAt 无来源 → manual', () => {
    const legacyText = [
      '---',
      'key: "legacy"',
      'title: "老专题"',
      'summary: "老摘要"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "amber"',
      'archivedAt: "2026-11-07T00:00:00.000Z"',
      '---',
      '老正文',
    ].join('\n');
    const parsed = parseTopicFile(Buffer.from(legacyText, 'utf8'));
    assert.equal(parsed.retention, 'standing');
    assert.equal(parsed.archiveOrigin, 'manual', '已有 archivedAt 但无来源 → 人工归档');
    // plain 标量也接受（与 archivedAt 磁盘口径一致）
    const plainText = legacyText.replace('scopeId: "amber"', 'scopeId: "amber"\nretention: historical\narchiveOrigin: auto-inactive');
    const plain = parseTopicFile(Buffer.from(plainText, 'utf8'));
    assert.equal(plain.retention, 'historical');
    assert.equal(plain.archiveOrigin, 'auto-inactive');
  });

  it('非法枚举：写入侧 INVALID_INPUT（含类型错），磁盘侧 INVALID_STATE，不静默纠正', () => {
    // 写入侧
    for (const bad of ['bogus', 'FROZEN', '', 42, true, null]) {
      // null/'' 为缺省/清除哨兵整行省略，只有其余非法值抛错
      if (bad === null || bad === '') continue;
      assert.throws(() => serializeTopicFile({ ...META, retention: bad }, 'b'),
        (e) => e.code === 'INVALID_INPUT' && /retention/.test(e.message), `retention=${String(bad)}`);
      assert.throws(() => serializeTopicFile({ ...META, archiveOrigin: bad }, 'b'),
        (e) => e.code === 'INVALID_INPUT' && /archiveOrigin/.test(e.message), `archiveOrigin=${String(bad)}`);
    }
    // 磁盘侧（已落盘的非法数据 = INVALID_STATE）
    const base = '---\nkey: "a"\ntitle: "t"\nsummary: "s"\nupdated: "u"\nscopeId: "g"\n';
    assert.throws(() => parseTopicFile(Buffer.from(`${base}retention: "bogus"\n---\nb`, 'utf8')),
      (e) => e.code === 'INVALID_STATE' && /retention/.test(e.message));
    assert.throws(() => parseTopicFile(Buffer.from(`${base}archiveOrigin: nope\n---\nb`, 'utf8')),
      (e) => e.code === 'INVALID_STATE' && /archiveOrigin/.test(e.message));
  });

  it('字段重复 → INVALID_STATE（与既有重复口径一致）', () => {
    const text = '---\nkey: "a"\ntitle: "t"\nsummary: "s"\nupdated: "u"\nscopeId: "g"\n'
      + 'retention: "standing"\nretention: "historical"\n---\nb';
    assert.throws(() => parseTopicFile(Buffer.from(text, 'utf8')), (e) => e.code === 'INVALID_STATE');
  });

  it('旧文件字节零变化：无新字段的序列化输出与 0.4 版本逐字节一致', () => {
    // 老形状（不带新字段）序列化输出必须与既有口径完全一致（无 archiveOrigin/retention 行）
    const text = serializeTopicFile(META, '第一行\r\n第二行\n').toString('utf8');
    assert.equal(text, '---\nkey: "alpha"\ntitle: "标题 ✨"\nsummary: "摘"要"带引号"\n'
      .replace('summary: "摘"要"带引号"', `summary: ${JSON.stringify('摘"要"带引号')}`)
      + 'updated: "2026-10-24T12:00:00.000Z"\nscopeId: "amber"\n---\n第一行\r\n第二行\n');
    assert.doesNotMatch(text, /^archiveOrigin:/m);
    assert.doesNotMatch(text, /^retention:/m);
  });
});
