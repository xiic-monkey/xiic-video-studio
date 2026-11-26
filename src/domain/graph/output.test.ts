import { describe, expect, it } from 'vitest';
import { resolveInlineText, resolveNodeOutput } from './output';

describe('resolveNodeOutput', () => {
  it('resolves a media source without a run', () => {
    const node = { id: 'source', type: 'video_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { assetId: 'asset-local', kind: 'video' } } as never;
    expect(resolveNodeOutput(node, 'video', [])).toBe('asset-local');
  });

  it('uses the selected candidate for a generated node', () => {
    const node = { id: 'generated', type: 'image_generate', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: {} } as never;
    const run = { id: 'run', nodeId: 'generated', status: 'succeeded', selectedAssetId: 'asset-selected', outputAssetIds: ['asset-other'], startedAt: '2026-01-01T00:00:00Z' } as never;
    expect(resolveNodeOutput(node, 'output', [run])).toBe('asset-selected');
  });

  it('does not resolve a failed or unknown output port', () => {
    const node = { id: 'source', type: 'video_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { assetId: 'asset-local', kind: 'video' } } as never;
    expect(resolveNodeOutput(node, 'prompt', [])).toBeUndefined();
  });

  it('survives a dangling edge whose source node was deleted', () => {
    expect(resolveNodeOutput(undefined, 'output', [])).toBeUndefined();
  });

  it('素材节点不用跑就产出它选好的那段素材', () => {
    const image = { id: 'src', type: 'image_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { assetId: 'asset-pic' } } as never;
    expect(resolveNodeOutput(image, 'image', [])).toBe('asset-pic');
    const audio = { id: 'src', type: 'audio_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { assetId: 'asset-sound' } } as never;
    expect(resolveNodeOutput(audio, 'audio', [])).toBe('asset-sound');
    // 端口对不上就没有产出。
    expect(resolveNodeOutput(audio, 'image', [])).toBeUndefined();
    // 没选素材时没有产出。
    const empty = { id: 'src', type: 'image_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { assetId: '' } } as never;
    expect(resolveNodeOutput(empty, 'image', [])).toBeUndefined();
  });

  it('文本素材节点写下的文字就是它的产出，不用跑', () => {
    const node = { id: 'src', type: 'text_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { text: '角色设定：冷静的杀手' } } as never;
    expect(resolveInlineText(node, 'text')).toBe('角色设定：冷静的杀手');
    // 端口对不上就没有内联文本。
    expect(resolveInlineText(node, 'beats')).toBeUndefined();
    // 没写内容就没有产出。
    const empty = { id: 'src', type: 'text_source', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: { text: '' } } as never;
    expect(resolveInlineText(empty, 'text')).toBeUndefined();
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
