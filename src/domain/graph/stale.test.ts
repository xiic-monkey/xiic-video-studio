import { describe, expect, it } from 'vitest';
import type { CacheContext } from './cacheKey';
import { computeCacheKey } from './cacheKey';
import { computeStaleSet } from './stale';
import { edge, makeDoc, node } from './testFixtures';
import type { RunRecord } from '../types';

function run(nodeId: string, cacheKey: string): RunRecord {
  return {
    id: `run_${nodeId}`, projectId: 'project_test', boardId: 'board_test', nodeId,
    action: 'generate', cacheKey, status: 'succeeded',
    promptSnapshot: { text: '', segments: [], hash: 'h', locked: false },
    params: {}, inputAssetIds: [], outputAssetIds: [`asset_${nodeId}`], selectedAssetId: `asset_${nodeId}`,
    startedAt: '2026-10-31T00:00:00.000Z',
  };
}

describe('computeStaleSet', () => {
  it('marks nodes without successful runs stale', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const ctx: CacheContext = { runs: [], runtime: {}, promptHashes: {} };
    expect([...computeStaleSet(doc, ctx, new Set())].sort()).toEqual(['a', 'b']);
  });

  it('keeps a node fresh when its cache key matches the last run and upstream is fresh', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const ctx: CacheContext = { runs: [], runtime: {}, promptHashes: {} };
    const aKey = computeCacheKey(doc, 'a', ctx);
    const freshCtx: CacheContext = { ...ctx, runs: [run('a', aKey)] };
    const bKey = computeCacheKey(doc, 'b', freshCtx);
    freshCtx.runs.push(run('b', bKey));
    expect([...computeStaleSet(doc, freshCtx, new Set())]).toEqual([]);
  });

  it('propagates staleness downstream', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image'), node('c', 'video')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]);
    const ctx: CacheContext = { runs: [], runtime: {}, promptHashes: {} };
    const aKey = computeCacheKey(doc, 'a', ctx);
    const staleCtx: CacheContext = { ...ctx, runs: [run('a', aKey)] };
    expect([...computeStaleSet(doc, staleCtx, new Set())].sort()).toEqual(['b', 'c']);
  });

  it('stops propagation at a pinned node', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image'), node('c', 'video')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]);
    const seeded: CacheContext = { runs: [run('b', 'placeholder'), run('c', 'placeholder')], runtime: {}, promptHashes: {} };
    const bKey = computeCacheKey(doc, 'b', seeded);
    const cKey = computeCacheKey(doc, 'c', seeded);
    const ctx: CacheContext = { ...seeded, runs: [run('b', bKey), run('c', cKey)] };
    expect([...computeStaleSet(doc, ctx, new Set())].sort()).toEqual(['a', 'b', 'c']);
    expect([...computeStaleSet(doc, ctx, new Set(['b']))].sort()).toEqual(['a']);
  });
});
