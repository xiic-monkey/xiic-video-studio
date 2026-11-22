import { applyTimelineEdit, compileTimeline, TICKS_PER_SECOND, type TimelineData, type TimelineEdit, type ProbedAsset } from '../domain/media/timeline';

export interface TimelineControllerState { timeline: TimelineData; exportRevision: number; exportStatus: 'idle' | 'running' | 'succeeded' | 'failed' }
export function createLocalCompose(projectId: string, boardId: string, orderedAssets: Array<{ id: string; duration?: number }>): TimelineData {
  return {
    id: `${projectId}:${boardId}:compose`,
    revision: 1,
    assemblyScope: 'local',
    clips: orderedAssets.map((asset, index) => ({
      id: `clip_${index + 1}`,
      assetId: asset.id,
      sourceInTicks: 0,
      sourceOutTicks: Math.max(0, Math.round((asset.duration ?? 0) * TICKS_PER_SECOND)),
    })),
    subtitleCues: [],
  };
}
export function commitTimelineEdit(state: TimelineControllerState, edit: TimelineEdit): TimelineControllerState { return { ...state, timeline: applyTimelineEdit(state.timeline, edit) }; }
export function canConfirmExport(state: TimelineControllerState, assets: Record<string, ProbedAsset>): boolean { return !compileTimeline(state.timeline, assets).issues.some((issue) => issue.severity === 'error'); }
