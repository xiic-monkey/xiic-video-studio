import { describe, expect, it } from 'vitest';
import { buildEpisodeAssembly } from './assembly';

describe('episode assembly', () => {
  it('freezes adopted shot assets in order and builds an episode timeline', () => {
    const result = buildEpisodeAssembly('p', 'b', 'episode-1', '第一集', [
      { id: 'shot-2', order: 2, durationMs: 1200, selectedAssetId: 'asset-2', assetDurationTicks: 400_000 },
      { id: 'shot-1', order: 1, durationMs: 1800, selectedAssetId: 'asset-1', assetDurationTicks: 500_000 },
    ]);

    expect(result.issues).toEqual([]);
    expect(result.episode.requiredShotIds).toEqual(['shot-1', 'shot-2']);
    expect(result.episode.frozenShots).toEqual([
      { shotId: 'shot-1', assetId: 'asset-1' },
      { shotId: 'shot-2', assetId: 'asset-2' },
    ]);
    expect(result.timeline.clips.map((clip) => clip.assetId)).toEqual(['asset-1', 'asset-2']);
    expect(result.timeline.clips.map((clip) => clip.sourceOutTicks)).toEqual([432_000, 288_000]);
    expect(result.timeline.assemblyScope).toBe('episode');
  });

  it('blocks assembly when a shot has no adopted video', () => {
    const result = buildEpisodeAssembly('p', 'b', 'episode-1', '第一集', [
      { id: 'shot-1', order: 1, durationMs: 1800, assetDurationTicks: 500_000 },
    ]);

    expect(result.issues).toEqual([{ shotId: 'shot-1', code: 'SHOT_VIDEO_NOT_ADOPTED' }]);
    expect(result.timeline.clips).toEqual([]);
  });

  it('flags adopted videos that are shorter than the planned shot duration', () => {
    const result = buildEpisodeAssembly('p', 'b', 'episode-1', '第一集', [
      { id: 'shot-1', order: 1, durationMs: 3000, selectedAssetId: 'asset-1', assetDurationTicks: 500_000 },
    ]);

    expect(result.issues).toEqual([{ shotId: 'shot-1', code: 'SHOT_ASSET_SHORTER_THAN_SPEC' }]);
    expect(result.episode.durationAdjustments).toEqual([{ shotId: 'shot-1', plannedTicks: 720_000, assembledTicks: 500_000 }]);
  });
});
