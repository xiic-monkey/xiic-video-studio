import { describe, expect, it } from 'vitest';
import { resolveNodeOutput } from './output';

describe('resolveNodeOutput', () => {
  it('resolves a media source without a run', () => {
    const node = { id: 'source', type: 'media_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { assetId: 'asset-local', kind: 'video' } } as never;
    expect(resolveNodeOutput(node, 'video', [])).toBe('asset-local');
  });

  it('uses the selected candidate for a generated node', () => {
    const node = { id: 'generated', type: 'image_generate', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: {} } as never;
    const run = { id: 'run', nodeId: 'generated', status: 'succeeded', selectedAssetId: 'asset-selected', outputAssetIds: ['asset-other'], startedAt: '2026-01-01T00:00:00Z' } as never;
    expect(resolveNodeOutput(node, 'output', [run])).toBe('asset-selected');
  });

  it('does not resolve a failed or unknown output port', () => {
    const node = { id: 'source', type: 'media_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { assetId: 'asset-local', kind: 'video' } } as never;
    expect(resolveNodeOutput(node, 'prompt', [])).toBeUndefined();
  });

  it('survives a dangling edge whose source node was deleted', () => {
    expect(resolveNodeOutput(undefined, 'output', [])).toBeUndefined();
  });

  it('keeps the last successful output when a newer attempt failed or is still running', () => {
    const node = { id: 'generated', type: 'image_generate', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: {} } as never;
    const succeeded = { id: 'run_ok', nodeId: 'generated', status: 'succeeded', selectedAssetId: 'asset-ok', outputAssetIds: ['asset-ok'], startedAt: '2026-01-01T00:00:00Z' } as never;
    const failed = { id: 'run_bad', nodeId: 'generated', status: 'failed', selectedAssetId: undefined, outputAssetIds: [], startedAt: '2026-01-02T00:00:00Z' } as never;
    const running = { id: 'run_now', nodeId: 'generated', status: 'running', selectedAssetId: undefined, outputAssetIds: [], startedAt: '2026-01-03T00:00:00Z' } as never;
    expect(resolveNodeOutput(node, 'output', [succeeded, failed])).toBe('asset-ok');
    expect(resolveNodeOutput(node, 'output', [succeeded, running])).toBe('asset-ok');
    expect(resolveNodeOutput(node, 'output', [failed])).toBeUndefined();
  });
});
