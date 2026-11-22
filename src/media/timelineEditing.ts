import { compileTimeline, TICKS_PER_SECOND, type ProbedAsset, type TimelineData, type TimelineIssue } from '../domain/media/timeline';
import type { AssetRef } from '../domain/types';

/** 时间线输入框的显示精度（秒的小数位）。 */
export const TIMELINE_SECONDS_PRECISION = 3;

export function formatTimelineSeconds(ticks: number): string {
  return (ticks / TICKS_PER_SECOND).toFixed(TIMELINE_SECONDS_PRECISION);
}

export function parseTimelineTicks(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * TICKS_PER_SECOND);
}

/** 半个显示单位的容差：显示精度以内的差异不算用户改动。 */
export function timelineSecondsTolerance(): number {
  return Math.round(TICKS_PER_SECOND * 0.5 / 10 ** TIMELINE_SECONDS_PRECISION);
}

export function timelineNumberDraftKey(scope: 'clip' | 'audio', id: string, field: string): string {
  return `${scope}:${id}:${field}`;
}

export interface TimelineNumberDraft { value: string; ticks: number; changed: boolean; valid: boolean }

/**
 * 解析输入框草稿：显示值来自草稿，提交值来自解析结果。
 * 未修改时不提交，避免无意义写入和修订递增。
 */
export function resolveTimelineNumberDraft(draft: string | undefined, originalTicks: number): TimelineNumberDraft {
  const original = formatTimelineSeconds(originalTicks);
  if (draft === undefined) return { value: original, ticks: originalTicks, changed: false, valid: true };
  const parsed = parseTimelineTicks(draft);
  if (parsed === null) return { value: draft, ticks: originalTicks, changed: false, valid: false };
  const changed = parsed !== originalTicks && Math.abs(parsed - originalTicks) > timelineSecondsTolerance();
  return { value: draft, ticks: parsed, changed, valid: true };
}

/** 把项目素材列表转成时间线编译需要的探测信息；时长未知的素材不参与区间校验。 */
export function buildProbedAssets(assets: readonly AssetRef[]): Record<string, ProbedAsset> {
  const probed: Record<string, ProbedAsset> = {};
  for (const asset of assets) {
    probed[asset.id] = {
      id: asset.id,
      kind: asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : 'video',
      durationTicks: asset.duration === undefined ? Number.POSITIVE_INFINITY : Math.round(asset.duration * TICKS_PER_SECOND),
    };
  }
  return probed;
}

const ISSUE_LABELS: Record<string, string> = {
  TIMELINE_SOURCE_MISSING: '缺少素材',
  TIMELINE_RANGE_INVALID: '入出点无效',
  TIMELINE_CLIP_TOO_SHORT: '短于一帧',
  SUBTITLE_OUT_OF_RANGE: '字幕越界',
  TIMELINE_AUDIO_TRACK_INVALID: '音轨无效',
};

export function describeTimelineIssues(issues: readonly TimelineIssue[], clipIndex?: (clipId: string) => number): string[] {
  return issues.map((issue) => {
    const label = ISSUE_LABELS[issue.code] ?? issue.code;
    const position = issue.clipId && clipIndex ? `片段 ${clipIndex(issue.clipId)} ` : '';
    return `${position}${label}：${issue.message}`;
  });
}

export interface TimelineValidation { errors: string[]; warnings: string[] }

/**
 * 保存前的前置校验：error 级问题必须先修，warning 级只提示。
 * 素材列表还没加载出来时（probed 为空）不判「缺少素材」，避免误拦。
 */
export function validateTimelineForSave(data: TimelineData, probed: Record<string, ProbedAsset>): TimelineValidation {
  const plan = compileTimeline(data, probed);
  const clipIndex = (clipId: string) => data.clips.findIndex((clip) => clip.id === clipId) + 1;
  const relevant = Object.keys(probed).length ? plan.issues : plan.issues.filter((issue) => issue.code !== 'TIMELINE_SOURCE_MISSING');
  return {
    errors: describeTimelineIssues(relevant.filter((issue) => issue.severity === 'error'), clipIndex),
    warnings: describeTimelineIssues(relevant.filter((issue) => issue.severity === 'warning'), clipIndex),
  };
}
