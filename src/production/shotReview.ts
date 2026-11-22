export type ShotReviewState = 'draft' | 'review' | 'approved' | 'rejected';

/**
 * 后端制作审批状态机（spec §4.3）：draft → review → approved / rejected。
 * 目标状态与当前状态相同视为幂等，所以只有当前不是 review 时才需要先提交 review。
 */
export function nextReviewStates(current: string | undefined): ShotReviewState[] {
  const state = current ?? 'draft';
  return state === 'review' ? ['approved'] : ['review', 'approved'];
}

export function describeReviewError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes('PRODUCTION_VALIDATION_FAILED')) return `审批失败（${message}）：镜头规格与已采用记录不一致或状态转移非法，请重新保存规格、采用视频候选后再审批。`;
  return `审批失败：${message}`;
}
