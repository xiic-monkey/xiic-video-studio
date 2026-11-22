import { describe, expect, it } from 'vitest';
import { buildBreakdownDiff, buildBreakdownThreeWayDiff, makeLocalBreakdownDraft, validateBreakdownDraft, type BreakdownDraft } from './breakdown';

const draft: BreakdownDraft = { scriptId: 's', scriptRevision: 1, subjects: ['hero'], shots: [{ localId: 'shot-1', source: { startLine: 1, endLine: 2 }, action: '走进房间', dialogue: '你好', subjectRefs: ['hero'] }] };
describe('breakdown drafts', () => {
  it('creates an editable local draft with stable source line anchors', () => {
    const result = makeLocalBreakdownDraft('script-a', 3, '开门\n角色进入\n你好');
    expect(result.shots).toHaveLength(3);
    expect(result.shots[1].source).toEqual({ startLine: 2, endLine: 2 });
    expect(result.shots[2].action).toBe('你好');
  });
  it('rejects invalid source lines and references', () => expect(validateBreakdownDraft({ ...draft, shots: [{ ...draft.shots[0], source: { startLine: 0, endLine: 4 }, subjectRefs: ['missing'] }] }, 3)).toEqual(['BREAKDOWN_SOURCE_RANGE:shot-1', 'BREAKDOWN_SUBJECT_UNKNOWN:shot-1']));
  it('preserves human edits and marks ambiguous anchors', () => {
    const next = { ...draft, shots: [{ ...draft.shots[0], action: '停下' }, { ...draft.shots[0], localId: 'shot-2' }] };
    const diff = buildBreakdownDiff(next, draft);
    expect(diff.changed).toHaveLength(1);
    expect(diff.ambiguous).toHaveLength(1);
  });
  it('separates model changes from human conflicts and keeps adopted media metadata', () => {
    const baseline = draft;
    const current = [{ entityId: 'shot-1', ...draft.shots[0], action: '人工动作', selected: { video: { adoptionId: 'a1' } } }];
    const next = { ...draft, shots: [{ ...draft.shots[0], action: '模型动作' }] };
    const diff = buildBreakdownThreeWayDiff(next, baseline, current);
    expect(diff.conflicts).toHaveLength(1);
    expect(diff.conflicts[0].current.selected).toEqual({ video: { adoptionId: 'a1' } });
    expect(diff.preserved).toHaveLength(0);
  });

  it('marks duplicate anchors as ambiguous instead of choosing by display order', () => {
    const next = { ...draft, shots: [{ ...draft.shots[0], localId: 'a' }, { ...draft.shots[0], localId: 'b' }] };
    const diff = buildBreakdownThreeWayDiff(next, draft, []);
    expect(diff.ambiguous.map((item) => item.localId)).toEqual(['a', 'b']);
  });
});
