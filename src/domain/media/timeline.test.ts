import { describe, expect, it } from 'vitest';
import { compileTimeline, previewClipReplacement, TICKS_PER_SECOND, updateAudioTrack, type TimelineData } from './timeline';

const assets = {
  a: { id: 'a', kind: 'video' as const, durationTicks: 5 * TICKS_PER_SECOND },
  b: { id: 'b', kind: 'video' as const, durationTicks: 6 * TICKS_PER_SECOND },
  c: { id: 'c', kind: 'video' as const, durationTicks: 4 * TICKS_PER_SECOND },
};

describe('timeline compiler', () => {
  it('rejects audio tracks outside project audio assets or with invalid gain', () => {
    const base: TimelineData = { id: 't', revision: 1, assemblyScope: 'local', clips: [] };
    const wrongKind = compileTimeline({ ...base, audioTracks: [{ id: 'voice', assetId: 'voice', sourceInTicks: 0, sourceOutTicks: 240_000, timelineInTicks: 0, gain: 1.5 }] }, { voice: { id: 'voice', kind: 'video', durationTicks: 480_000 } });
    expect(wrongKind.issues.map((issue) => issue.code)).toContain('TIMELINE_AUDIO_TRACK_INVALID');
    const invalidGain = compileTimeline({ ...base, audioTracks: [{ id: 'voice', assetId: 'voice', sourceInTicks: 0, sourceOutTicks: 240_000, timelineInTicks: 0, gain: 5 }] }, { voice: { id: 'voice', kind: 'audio', durationTicks: 480_000 } });
    expect(invalidGain.issues.map((issue) => issue.code)).toContain('TIMELINE_AUDIO_TRACK_INVALID');
  });

  it('updates audio timing and gain without mutating the source timeline', () => {
    const timeline: TimelineData = { id: 't', revision: 1, assemblyScope: 'local', clips: [], audioTracks: [{ id: 'voice', assetId: 'voice', sourceInTicks: 0, sourceOutTicks: 240_000, timelineInTicks: 0, gain: 1 }] };
    const updated = updateAudioTrack(timeline, 'voice', { sourceInTicks: 24_000, sourceOutTicks: 200_000, timelineInTicks: 48_000, gain: 0.7 });
    expect(updated.audioTracks?.[0]).toMatchObject({ sourceInTicks: 24_000, sourceOutTicks: 200_000, timelineInTicks: 48_000, gain: 0.7 });
    expect(timeline.audioTracks?.[0].gain).toBe(1);
  });

  it('includes audio timing and gain in the frozen edit hash', () => {
    const timeline: TimelineData = { id: 't', revision: 1, assemblyScope: 'local', clips: [{ id: 'clip', assetId: 'a', sourceInTicks: 0, sourceOutTicks: TICKS_PER_SECOND }], audioTracks: [{ id: 'music', assetId: 'music', sourceInTicks: 0, sourceOutTicks: TICKS_PER_SECOND, timelineInTicks: 0, gain: 1 }] };
    const assets = { a: { id: 'a', kind: 'video' as const, durationTicks: TICKS_PER_SECOND }, music: { id: 'music', kind: 'audio' as const, durationTicks: 2 * TICKS_PER_SECOND } };
    expect(compileTimeline(timeline, assets).editHash).not.toBe(compileTimeline({ ...timeline, audioTracks: [{ ...timeline.audioTracks![0], gain: 0.5 }] }, assets).editHash);
  });

  it('trims 4/5/3 sources to exactly 300 frames', () => {
    const data: TimelineData = { id: 't', revision: 1, assemblyScope: 'local', clips: [
      { id: 'a', assetId: 'a', sourceInTicks: 0.5 * TICKS_PER_SECOND, sourceOutTicks: 4.5 * TICKS_PER_SECOND },
      { id: 'b', assetId: 'b', sourceInTicks: TICKS_PER_SECOND, sourceOutTicks: 4 * TICKS_PER_SECOND },
      { id: 'c', assetId: 'c', sourceInTicks: 0.5 * TICKS_PER_SECOND, sourceOutTicks: 3.5 * TICKS_PER_SECOND },
    ]};
    const plan = compileTimeline(data, assets);
    expect(plan.totalTicks).toBe(10 * TICKS_PER_SECOND);
    expect(plan.clips.reduce((sum, clip) => sum + clip.frameCount, 0)).toBe(300);
    expect(plan.issues).toEqual([]);
  });
});

describe('clip replacement preview', () => {
  it('requires confirmation and preserves the source in-point when the new asset is shorter', () => {
    expect(previewClipReplacement({ id: 'clip', assetId: 'old', sourceInTicks: 240_000, sourceOutTicks: 720_000 }, 600_000)).toEqual({
      sourceInTicks: 240_000,
      sourceOutTicks: 600_000,
      requiresConfirmation: true,
      lostTicks: 120_000,
      hasValidRange: true,
    });
  });

  it('rejects replacement assets that cannot preserve the source in-point', () => {
    expect(previewClipReplacement({ id: 'clip', assetId: 'old', sourceInTicks: 240_000, sourceOutTicks: 720_000 }, 200_000).hasValidRange).toBe(false);
  });
});
