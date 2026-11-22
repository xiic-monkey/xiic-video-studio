import { describe, expect, it } from 'vitest';
import type { BreakdownDraft } from '../domain/production/breakdown';
import { isBreakdownDraftStale, selectBreakdownDraftForRevision, stableBreakdownDraftId } from './breakdownDrafts';

function draft(scriptRevision: number, action = 'a'): BreakdownDraft {
  return { scriptId: 'script_1', scriptRevision, shots: [{ localId: 'local-shot-1', source: { startLine: 1, endLine: 1 }, action, dialogue: '', subjectRefs: [] }], subjects: [] };
}

describe('breakdown drafts', () => {
  it('derives a stable draft id from script id and revision', () => {
    expect(stableBreakdownDraftId('script_1', 3)).toBe('draft_script_1_3');
    expect(stableBreakdownDraftId('script_1', 3)).toBe(stableBreakdownDraftId('script_1', 3));
    expect(stableBreakdownDraftId('script_1', 4)).not.toBe(stableBreakdownDraftId('script_1', 3));
  });

  it('restores the draft that matches the current script revision', () => {
    const items = [
      { draftId: 'draft_script_1_1', scriptRevision: 1, payload: draft(1) },
      { draftId: 'draft_script_1_2', scriptRevision: 2, payload: draft(2, 'b') },
    ];
    expect(selectBreakdownDraftForRevision(items, 2)?.shots[0].action).toBe('b');
    expect(selectBreakdownDraftForRevision(items, 1)?.shots[0].action).toBe('a');
    expect(selectBreakdownDraftForRevision(items, 9)).toBeUndefined();
  });

  it('flags a draft that was made against an older script revision', () => {
    expect(isBreakdownDraftStale(draft(1), 2)).toBe(true);
    expect(isBreakdownDraftStale(draft(2), 2)).toBe(false);
    expect(isBreakdownDraftStale(undefined, 2)).toBe(false);
  });
});
