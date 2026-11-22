import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND, type TimelineData } from '../domain/media/timeline';
import type { AssetRef } from '../domain/types';
import { buildProbedAssets, formatTimelineSeconds, parseTimelineTicks, resolveTimelineNumberDraft, timelineNumberDraftKey, validateTimelineForSave } from './timelineEditing';

const timeline: TimelineData = { id: 't', revision: 1, assemblyScope: 'local', clips: [{ id: 'clip_1', assetId: 'a', sourceInTicks: 0, sourceOutTicks: TICKS_PER_SECOND }] };

function asset(id: string, duration?: number): AssetRef {
  return { id, kind: 'video', path: `${id}.mp4`, mime: 'video/mp4', duration, bytes: 1, createdAt: '', provenance: { projectId: 'p' } };
}

describe('timeline number drafts', () => {
  it('keeps three decimals so a tick value survives the display round trip', () => {
    expect(formatTimelineSeconds(8000)).toBe('0.033');
    expect(resolveTimelineNumberDraft(undefined, 8000).value).toBe('0.033');
  });

  it('treats the untouched display value as unchanged', () => {
    const resolution = resolveTimelineNumberDraft(formatTimelineSeconds(8000), 8000);
    expect(resolution.changed).toBe(false);
  });

  it('detects a real edit and returns the parsed tick value', () => {
    const resolution = resolveTimelineNumberDraft('1.5', 8000);
    expect(resolution.changed).toBe(true);
    expect(resolution.ticks).toBe(360_000);
  });

  it('rejects a non numeric entry without submitting', () => {
    const resolution = resolveTimelineNumberDraft('abc', 8000);
    expect(resolution.valid).toBe(false);
    expect(resolution.changed).toBe(false);
  });

  it('parses seconds into ticks and refuses negative values', () => {
    expect(parseTimelineTicks('2')).toBe(2 * TICKS_PER_SECOND);
    expect(parseTimelineTicks('-1')).toBeNull();
    expect(parseTimelineTicks('')).toBeNull();
  });

  it('keys drafts by scope, id and field', () => {
    expect(timelineNumberDraftKey('clip', 'clip_1', 'sourceIn')).toBe('clip:clip_1:sourceIn');
    expect(timelineNumberDraftKey('audio', 'voice', 'gain')).toBe('audio:voice:gain');
  });
});

describe('timeline save validation', () => {
  it('builds probed assets from project durations', () => {
    expect(buildProbedAssets([asset('a', 5)]).a.durationTicks).toBe(5 * TICKS_PER_SECOND);
  });

  it('blocks an inverted clip range', () => {
    const broken: TimelineData = { ...timeline, clips: [{ id: 'clip_1', assetId: 'a', sourceInTicks: TICKS_PER_SECOND, sourceOutTicks: 0 }] };
    const validation = validateTimelineForSave(broken, buildProbedAssets([asset('a', 5)]));
    expect(validation.errors.join('、')).toContain('入出点无效');
  });

  it('blocks subtitles that run past the new total length', () => {
    const withCue: TimelineData = { ...timeline, subtitleCues: [{ id: 'cue_1', startTicks: 0, endTicks: 10 * TICKS_PER_SECOND, text: 'x' }] };
    const validation = validateTimelineForSave(withCue, buildProbedAssets([asset('a', 5)]));
    expect(validation.errors.join('、')).toContain('字幕越界');
  });

  it('accepts a valid timeline', () => {
    expect(validateTimelineForSave(timeline, buildProbedAssets([asset('a', 5)])).errors).toEqual([]);
  });

  it('does not blame missing assets while the asset list is still empty', () => {
    const validation = validateTimelineForSave(timeline, {});
    expect(validation.errors).toEqual([]);
  });
});
