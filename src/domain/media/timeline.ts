export const TICKS_PER_SECOND = 240_000;
export const TICKS_PER_FRAME = 8_000;

export interface ProbedAsset {
  id: string;
  kind: 'video' | 'audio' | 'image';
  durationTicks: number;
  fps?: number;
  hasAudio?: boolean;
}

export interface TimelineClip {
  id: string;
  assetId: string;
  enabled?: boolean;
  sourceInTicks: number;
  sourceOutTicks: number;
  timelineInTicks?: number;
  subtitleAnchorIds?: string[];
}
export interface TimelineAudioTrack { id: string; assetId: string; sourceInTicks: number; sourceOutTicks: number; timelineInTicks: number; gain: number }

export interface TimelineData {
  id: string;
  revision: number;
  assemblyScope: 'local' | 'episode';
  clips: TimelineClip[];
  subtitleCues?: SubtitleCue[];
  audioTracks?: TimelineAudioTrack[];
}

export interface SubtitleCue {
  id: string;
  startTicks: number;
  endTicks: number;
  text: string;
  anchorClipId?: string;
}

export interface TimelineIssue { code: string; message: string; severity: 'error' | 'warning'; clipId?: string }
export interface ClipReplacementPreview {
  sourceInTicks: number;
  sourceOutTicks: number;
  requiresConfirmation: boolean;
  lostTicks: number;
  hasValidRange: boolean;
}
export interface CompiledClip extends TimelineClip { timelineInTicks: number; timelineOutTicks: number; frameCount: number }
export interface TimelinePlan { clips: CompiledClip[]; totalTicks: number; issues: TimelineIssue[]; editHash: string }

function frameCount(ticks: number): number { return Math.max(0, Math.round(ticks / TICKS_PER_FRAME)); }

export function compileTimeline(data: TimelineData, assets: Readonly<Record<string, ProbedAsset>>): TimelinePlan {
  const issues: TimelineIssue[] = [];
  const clips: CompiledClip[] = [];
  let cursor = 0;
  for (const clip of data.clips) {
    if (clip.enabled === false) continue;
    const asset = assets[clip.assetId];
    const duration = clip.sourceOutTicks - clip.sourceInTicks;
    if (!asset) { issues.push({ code: 'TIMELINE_SOURCE_MISSING', message: `缺少素材 ${clip.assetId}`, severity: 'error', clipId: clip.id }); continue; }
    if (clip.sourceInTicks < 0 || clip.sourceOutTicks <= clip.sourceInTicks || clip.sourceOutTicks > asset.durationTicks) {
      issues.push({ code: 'TIMELINE_RANGE_INVALID', message: '片段入出点超出素材范围', severity: 'error', clipId: clip.id }); continue;
    }
    if (duration < TICKS_PER_FRAME) issues.push({ code: 'TIMELINE_CLIP_TOO_SHORT', message: '片段短于一帧', severity: 'error', clipId: clip.id });
    const timelineInTicks = cursor;
    const compiled = { ...clip, timelineInTicks, timelineOutTicks: timelineInTicks + duration, frameCount: frameCount(duration) };
    clips.push(compiled);
    cursor += duration;
  }
  const cueIds = new Set<string>();
  for (const cue of data.subtitleCues ?? []) {
    if (cueIds.has(cue.id) || cue.startTicks < 0 || cue.endTicks <= cue.startTicks || cue.endTicks > cursor) {
      issues.push({ code: 'SUBTITLE_OUT_OF_RANGE', message: `字幕 ${cue.id} 超出时间线`, severity: 'error' });
    }
    cueIds.add(cue.id);
  }
  for (const track of data.audioTracks ?? []) {
    const asset = assets[track.assetId];
    const duration = track.sourceOutTicks - track.sourceInTicks;
    if (!asset || asset.kind !== 'audio' || !Number.isFinite(track.gain) || track.gain < 0 || track.gain > 2 || track.sourceInTicks < 0 || duration <= 0 || track.sourceOutTicks > asset.durationTicks || track.timelineInTicks < 0) {
      issues.push({ code: 'TIMELINE_AUDIO_TRACK_INVALID', message: `音轨 ${track.id} 无效`, severity: 'error' });
    }
  }
  const editHash = JSON.stringify({ clips, audioTracks: data.audioTracks ?? [], cues: data.subtitleCues ?? [] });
  return { clips, totalTicks: cursor, issues, editHash };
}

export function previewClipReplacement(clip: TimelineClip, replacementDurationTicks: number): ClipReplacementPreview {
  const currentDuration = Math.max(0, clip.sourceOutTicks - clip.sourceInTicks);
  const available = Math.max(0, replacementDurationTicks - clip.sourceInTicks);
  const nextDuration = Math.min(currentDuration, available);
  const sourceOutTicks = clip.sourceInTicks + nextDuration;
  return {
    sourceInTicks: clip.sourceInTicks,
    sourceOutTicks,
    requiresConfirmation: nextDuration < currentDuration,
    lostTicks: currentDuration - nextDuration,
    hasValidRange: sourceOutTicks > clip.sourceInTicks,
  };
}

export type TimelineEdit =
  | { type: 'reorder'; clipId: string; toIndex: number }
  | { type: 'trim'; clipId: string; sourceInTicks?: number; sourceOutTicks?: number }
  | { type: 'replace'; clipId: string; assetId: string; sourceInTicks: number; sourceOutTicks: number; acknowledgeShorter?: boolean };

export type AudioTrackEdit = Partial<Pick<TimelineAudioTrack, 'sourceInTicks' | 'sourceOutTicks' | 'timelineInTicks' | 'gain'>>;

export function updateAudioTrack(data: TimelineData, trackId: string, edit: AudioTrackEdit): TimelineData {
  const tracks = data.audioTracks ?? [];
  if (!tracks.some((track) => track.id === trackId)) throw new Error('TIMELINE_AUDIO_TRACK_NOT_FOUND');
  return { ...data, audioTracks: tracks.map((track) => track.id === trackId ? { ...track, ...edit } : { ...track }), revision: data.revision + 1 };
}

export function removeAudioTrack(data: TimelineData, trackId: string): TimelineData {
  const tracks = data.audioTracks ?? [];
  if (!tracks.some((track) => track.id === trackId)) throw new Error('TIMELINE_AUDIO_TRACK_NOT_FOUND');
  return { ...data, audioTracks: tracks.filter((track) => track.id !== trackId), revision: data.revision + 1 };
}

export function applyTimelineEdit(data: TimelineData, edit: TimelineEdit): TimelineData {
  const clips = data.clips.map((clip) => ({ ...clip }));
  const index = clips.findIndex((clip) => clip.id === edit.clipId);
  if (index < 0) throw new Error('TIMELINE_CLIP_NOT_FOUND');
  if (edit.type === 'reorder') {
    const [clip] = clips.splice(index, 1);
    clips.splice(Math.max(0, Math.min(edit.toIndex, clips.length)), 0, clip);
  } else if (edit.type === 'trim') {
    clips[index] = { ...clips[index], sourceInTicks: edit.sourceInTicks ?? clips[index].sourceInTicks, sourceOutTicks: edit.sourceOutTicks ?? clips[index].sourceOutTicks };
  } else {
    clips[index] = { ...clips[index], assetId: edit.assetId, sourceInTicks: edit.sourceInTicks, sourceOutTicks: edit.sourceOutTicks };
  }
  return { ...data, clips, revision: data.revision + 1 };
}

function parseTime(value: string): number {
  // 同时接受 HH:MM:SS,mmm 和 MM:SS,mmm；缺省的小时数当 0。
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) throw new Error('SUBTITLE_TIME_INVALID');
  const hours = Number(match[1] ?? 0);
  return ((hours * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4])) * 240;
}

export function parseSrt(input: string): SubtitleCue[] {
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  return normalized.split(/\n\s*\n/).map((block, index) => {
    const lines = block.split('\n');
    const timing = lines.find((line) => line.includes('-->'));
    if (!timing) throw new Error('SUBTITLE_TIMING_MISSING');
    const [start, end] = timing.split('-->').map(parseTime);
    if (end <= start) throw new Error('SUBTITLE_RANGE_INVALID');
    return { id: `cue_${index + 1}`, startTicks: start, endTicks: end, text: lines.slice(lines.indexOf(timing) + 1).join('\n') };
  });
}

export function formatSrt(cues: readonly SubtitleCue[]): string {
  const millis = (ticks: number) => {
    const total = Math.max(0, Math.round(ticks / 240));
    const ms = total % 1000;
    const seconds = Math.floor(total / 1000);
    const s = seconds % 60;
    const minutes = Math.floor(seconds / 60) % 60;
    const hours = Math.floor(seconds / 3600);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return cues.map((cue, index) => `${index + 1}\n${millis(cue.startTicks)} --> ${millis(cue.endTicks)}\n${cue.text}`).join('\n\n') + (cues.length ? '\n' : '');
}
