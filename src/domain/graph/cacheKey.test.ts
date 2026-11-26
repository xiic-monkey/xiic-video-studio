import { describe, expect, it } from 'vitest';
import type { CacheContext } from './cacheKey';
import { computeCacheKey, selectedAssetOf } from './cacheKey';
import { edge, makeDoc, node } from './testFixtures';
import type { BoardDoc, RunRecord } from '../types';

function run(partial: Partial<RunRecord>): RunRecord {
  return {
    id: 'run_1', projectId: 'project_test', boardId: 'board_test', nodeId: 'a',
    action: 'generate', cacheKey: 'old', status: 'succeeded', promptSnapshot: { text: '', segments: [], hash: 'h', locked: false },
    params: {}, inputAssetIds: [], outputAssetIds: ['asset_upstream'], selectedAssetId: 'asset_upstream',
    startedAt: '2026-10-31T00:00:00.000Z', ...partial,
  };
}

const ctx: CacheContext = {
  runs: [run({ nodeId: 'a' })],
  runtime: { b: { providerId: 'openai-compatible', model: 'gpt-image-2.6-flare', params: { size: '1024x1536' } } },
  promptHashes: { b: 'prompt-hash' },
};

describe('computeCacheKey', () => {
  it('is stable regardless of position and ui changes', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const moved = { ...doc, nodes: { ...doc.nodes, b: { ...doc.nodes.b, position: { x: 999, y: 999 }, ui: { pinned: false } } } };
    expect(computeCacheKey(doc, 'b', ctx)).toBe(computeCacheKey(moved, 'b', ctx));
  });

  it('changes when the upstream selected asset changes', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const before = computeCacheKey(doc, 'b', ctx);
    const changed: CacheContext = { ...ctx, runs: [run({ nodeId: 'a', selectedAssetId: 'asset_other', outputAssetIds: ['asset_upstream', 'asset_other'] })] };
    expect(computeCacheKey(doc, 'b', changed)).not.toBe(before);
  });

  it('changes when prompt hash changes', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const before = computeCacheKey(doc, 'b', ctx);
    expect(computeCacheKey(doc, 'b', { ...ctx, promptHashes: { b: 'other-hash' } })).not.toBe(before);
  });

  it('selects the explicit candidate over the first output', () => {
    expect(selectedAssetOf(run({ selectedAssetId: 'asset_b', outputAssetIds: ['asset_a', 'asset_b'] }))).toBe('asset_b');
    expect(selectedAssetOf(run({ selectedAssetId: undefined, outputAssetIds: ['asset_a'] }))).toBe('asset_a');
  });

  it('survives a dangling edge whose source node was deleted', () => {
    const doc = makeDoc([node('b', 'image')], [edge('e1', 'a', 'b')]);
    // 悬空边按「缺输入」处理，不能让整块画布崩掉。
    expect(() => computeCacheKey(doc, 'b', ctx)).not.toThrow();
    expect(typeof computeCacheKey(doc, 'b', ctx)).toBe('string');
  });

  it('changes the downstream key when the script body changes', () => {
    const doc = makeDoc(
      [node('s', 'script', { body: '第一幕' }), node('i', 'image')],
      [edge('e1', 's', 'i', 'script', 'prompt', 'prompt')],
    );
    const before = computeCacheKey(doc, 'i', ctx);
    const edited: BoardDoc = {
      ...doc,
      nodes: { ...doc.nodes, s: { ...doc.nodes.s, data: { ...doc.nodes.s.data, body: '第一幕改' } } },
    };
    expect(computeCacheKey(edited, 'i', ctx)).not.toBe(before);
  });

  it('keeps the script node itself fresh after its body is written back', () => {
    const doc = makeDoc([node('s', 'script', { prompt: '写一场告别戏', body: '旧正文' })], []);
    const before = computeCacheKey(doc, 's', ctx);
    const written: BoardDoc = {
      ...doc,
      nodes: { ...doc.nodes, s: { ...doc.nodes.s, data: { ...doc.nodes.s.data, body: '新正文' } } },
    };
    // 正文是剧本节点的输出，不是它的输入：回填之后不该被判成「结果已过期」。
    expect(computeCacheKey(written, 's', ctx)).toBe(before);
  });
});
