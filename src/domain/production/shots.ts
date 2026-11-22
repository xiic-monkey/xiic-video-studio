import type { TimelineClip } from '../media/timeline';
import { sha256Json } from '../hash';

export interface ShotAdoption { adoptionId: string; shotId: string; slot: string; assetId: string; specHash: string; adoptedAt: string }
export interface ReplacePreview { canKeepIn: boolean; canKeepOut: boolean; requiresConfirmation: boolean; message?: string }

export function shotSpecHash(spec: Record<string, unknown>): string {
  const keys = ['title', 'action', 'dialogue', 'durationMs', 'aspectRatio', 'emotionalBeat', 'hook', 'bindings', 'previousTail', 'genericReferenceIds'];
  return sha256Json(Object.fromEntries(keys.filter((key) => key in spec).map((key) => [key, spec[key]])));
}

export function previewShotReplacement(clip: TimelineClip, adoption: ShotAdoption, asset: { durationTicks: number }): ReplacePreview {
  const duration = clip.sourceOutTicks - clip.sourceInTicks;
  if (asset.durationTicks < duration) return { canKeepIn: clip.sourceInTicks < asset.durationTicks, canKeepOut: false, requiresConfirmation: true, message: '新候选短于当前片段，需要确认裁切' };
  return { canKeepIn: true, canKeepOut: true, requiresConfirmation: false };
}
