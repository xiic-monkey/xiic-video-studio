import { sha256Json } from '../hash';

/**
 * 镜头参考解析的前端镜像。
 *
 * 入参与返回形状必须和后端 `src-tauri/src/production/references.rs` 一致
 * （字段名用后端的 camelCase 形式），否则接线时两边对不上。
 * 后端是这套契约的权威实现。
 */
export interface ShotReferenceInput {
  subjectVersionIds: string[];
  genericReferenceIds: string[];
  firstFrameId?: string;
  lastFrameId?: string;
  previousTailFrameId?: string;
}

export interface ExcludedShotReference {
  id: string;
  reason: string;
}

export interface ResolvedShotReferences {
  descriptor: string;
  orderedInputs: string[];
  excludedInputs: ExcludedShotReference[];
  fingerprint: string;
  /**
   * 超出额度时的提示：只提示，不静默截断输入（设计 §7.4）。
   * 后端当前不做额度判定，这一项是留给调用方的可选提示。
   */
  overCapacity?: boolean;
}

/** 默认参考额度：超过就要提示用户选择。 */
export const REFERENCE_CAPACITY = 9;

export function resolveShotReferences(input: ShotReferenceInput): ResolvedShotReferences {
  const orderedInputs: string[] = [];
  const excludedInputs: ExcludedShotReference[] = [];
  const seen = new Set<string>();
  for (const id of input.subjectVersionIds) { if (!seen.has(id)) { seen.add(id); orderedInputs.push(id); } else excludedInputs.push({ id, reason: 'duplicate_subject_version' }); }
  for (const id of input.genericReferenceIds) { if (input.firstFrameId === id || input.lastFrameId === id) excludedInputs.push({ id, reason: 'frame_port_reference_conflict' }); else if (!seen.has(id)) { seen.add(id); orderedInputs.push(id); } }
  if (input.firstFrameId) orderedInputs.push(input.firstFrameId);
  if (input.lastFrameId) orderedInputs.push(input.lastFrameId);
  if (input.previousTailFrameId) orderedInputs.push(input.previousTailFrameId);
  const descriptor = `subjects:${input.subjectVersionIds.length};generic:${input.genericReferenceIds.length};first:${Boolean(input.firstFrameId)};last:${Boolean(input.lastFrameId)}`;
  return {
    descriptor,
    orderedInputs,
    excludedInputs,
    fingerprint: sha256Json({ descriptor, orderedInputs }),
    overCapacity: orderedInputs.length > REFERENCE_CAPACITY,
  };
}
