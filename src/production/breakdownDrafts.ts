import type { BreakdownDraft } from '../domain/production/breakdown';

/** 同一剧本修订下的草案用同一个 id：反复保存是幂等的，不会堆出重复草案。 */
export function stableBreakdownDraftId(scriptId: string, scriptRevision: number): string {
  return `draft_${scriptId}_${scriptRevision}`;
}

export interface BreakdownDraftRecord {
  draftId?: string;
  scriptId?: string;
  scriptRevision?: number;
  payload?: BreakdownDraft;
}

function isDraftRecord(item: unknown): item is BreakdownDraftRecord {
  if (!item || typeof item !== 'object') return false;
  const payload = (item as { payload?: unknown }).payload;
  return Boolean(payload) && typeof payload === 'object' && Array.isArray((payload as { shots?: unknown }).shots);
}

/** 按剧本修订分组恢复草案：取匹配当前修订的那一条，而不是最后一条。 */
export function selectBreakdownDraftForRevision(items: readonly unknown[], scriptRevision: number): BreakdownDraft | undefined {
  const matched: BreakdownDraftRecord[] = [];
  for (const item of items) {
    if (isDraftRecord(item) && Number(item.scriptRevision) === scriptRevision) matched.push(item);
  }
  return matched.at(-1)?.payload;
}

/** 草案基于的剧本修订和当前剧本修订不一致时，草案已经过期。 */
export function isBreakdownDraftStale(draft: BreakdownDraft | undefined, scriptRevision: number): boolean {
  return Boolean(draft) && draft!.scriptRevision !== scriptRevision;
}

export const BREAKDOWN_STALE_MESSAGE = '剧本已修订，当前草案基于旧版本，请重新生成草案或应用后重算。';
