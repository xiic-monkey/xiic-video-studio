import type { TimelineClip, TimelineData } from '../media/timeline';

const TICKS_PER_MILLISECOND = 240;

export interface AssemblyShotInput {
  id: string;
  order: number;
  durationMs: number;
  selectedAssetId?: string;
  assetDurationTicks?: number;
}

export interface EpisodeAssemblyPlan {
  episode: {
    id: string;
    title: string;
    requiredShotIds: string[];
    frozenShots: Array<{ shotId: string; assetId: string }>;
    durationAdjustments: Array<{ shotId: string; plannedTicks: number; assembledTicks: number }>;
  };
  timeline: TimelineData;
  issues: Array<{ shotId: string; code: 'SHOT_VIDEO_NOT_ADOPTED' | 'SHOT_ASSET_DURATION_UNKNOWN' | 'SHOT_ASSET_SHORTER_THAN_SPEC' }>;
}

export function buildEpisodeAssembly(
  projectId: string,
  boardId: string,
  episodeId: string,
  title: string,
  shots: readonly AssemblyShotInput[],
): EpisodeAssemblyPlan {
  const ordered = [...shots].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const issues: EpisodeAssemblyPlan['issues'] = [];
  const frozenShots: EpisodeAssemblyPlan['episode']['frozenShots'] = [];
  const durationAdjustments: EpisodeAssemblyPlan['episode']['durationAdjustments'] = [];
  const clips: TimelineClip[] = [];

  for (const shot of ordered) {
    if (!shot.selectedAssetId) {
      issues.push({ shotId: shot.id, code: 'SHOT_VIDEO_NOT_ADOPTED' });
      continue;
    }
    if (!Number.isFinite(shot.assetDurationTicks) || (shot.assetDurationTicks ?? 0) <= 0) {
      issues.push({ shotId: shot.id, code: 'SHOT_ASSET_DURATION_UNKNOWN' });
      continue;
    }
    const requestedTicks = Math.max(TICKS_PER_MILLISECOND, Math.round(shot.durationMs * TICKS_PER_MILLISECOND));
    const sourceOutTicks = Math.min(requestedTicks, shot.assetDurationTicks!);
    if (sourceOutTicks < requestedTicks) {
      issues.push({ shotId: shot.id, code: 'SHOT_ASSET_SHORTER_THAN_SPEC' });
      durationAdjustments.push({ shotId: shot.id, plannedTicks: requestedTicks, assembledTicks: sourceOutTicks });
    }
    frozenShots.push({ shotId: shot.id, assetId: shot.selectedAssetId });
    clips.push({ id: `clip_${shot.id}`, assetId: shot.selectedAssetId, sourceInTicks: 0, sourceOutTicks, enabled: true });
  }

  const timelineId = `${projectId}:${boardId}:episode:${episodeId}`;
  return {
    episode: { id: episodeId, title, requiredShotIds: ordered.map((shot) => shot.id), frozenShots, durationAdjustments },
    timeline: { id: timelineId, revision: 1, assemblyScope: 'episode', clips, subtitleCues: [], audioTracks: [] },
    issues,
  };
}
