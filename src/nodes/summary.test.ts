import { describe, expect, it } from 'vitest';
import type { BoardNode, RunRecord } from '../domain/types';
import { durationLabel, indexLatest, modeLabel, outputAssetId, statusOf, summarizeNode } from './summary';

const node = (data: Record<string, unknown>): BoardNode => ({
  id: 'n1', type: 'text', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data,
});

const run = (patch: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1', projectId: 'p1', boardId: 'b1', nodeId: 'n1', action: 'generate', cacheKey: 'k',
  status: 'succeeded', promptSnapshot: { text: 't', segments: [], hash: 'h', locked: false },
  params: {}, inputAssetIds: [], outputAssetIds: ['asset_a', 'asset_b'],
  startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:00:07.500Z', ...patch,
});

describe('node summary', () => {
  it('prefers prompt and collapses whitespace', () => {
    expect(summarizeNode(node({ prompt: '  雨夜\n  街角  ' }))).toBe('雨夜 街角');
    expect(summarizeNode(node({ text: '台词' }))).toBe('台词');
    expect(summarizeNode(node({}))).toBe('空节点');
  });

  it('truncates long text with an ellipsis', () => {
    expect(summarizeNode(node({ prompt: 'x'.repeat(200) }), 10)).toBe('xxxxxxxxxx…');
  });

  it('maps modes and run status', () => {
    expect(modeLabel('t2v')).toBe('文生视频');
    expect(modeLabel('custom')).toBe('custom');
    expect(statusOf()).toEqual({ label: '未运行', tone: 'idle' });
    expect(statusOf(run({ status: 'failed' }))).toEqual({ label: '失败', tone: 'error' });
    expect(statusOf(run()).tone).toBe('ok');
  });

  it('prefers the selected candidate and requires success', () => {
    expect(outputAssetId(run())).toBe('asset_a');
    expect(outputAssetId(run({ selectedAssetId: 'asset_b' }))).toBe('asset_b');
    expect(outputAssetId(run({ status: 'running' }))).toBeUndefined();
  });

  it('formats run duration', () => {
    expect(durationLabel(run())).toBe('7.5s');
    expect(durationLabel(run({ finishedAt: undefined }))).toBe('');
  });

  it('indexes the latest run per node', () => {
    const older = run({ id: 'r_old', startedAt: '2026-10-31T00:00:00.000Z' });
    const newer = run({ id: 'r_new', startedAt: '2026-10-31T00:01:00.000Z' });
    expect(indexLatest([newer, older])).toEqual({ n1: 'r_new' });
  });
});
