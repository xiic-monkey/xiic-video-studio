import { describe, expect, it } from 'vitest';
import { resolveShotReferences } from './references';
describe('shot references', () => {
  it('deduplicates role assets but keeps first and last frames distinct', () => { const result = resolveShotReferences({ subjectVersionIds: ['role-v1', 'role-v1'], genericReferenceIds: ['ref'], firstFrameId: 'first', lastFrameId: 'last' }); expect(result.orderedInputs).toEqual(['role-v1', 'ref', 'first', 'last']); expect(result.excludedInputs[0].reason).toBe('duplicate_subject_version'); });
  it('renaming a subject does not change the resolved fingerprint', () => { const a = resolveShotReferences({ subjectVersionIds: ['role-v1'], genericReferenceIds: [] }); const b = resolveShotReferences({ subjectVersionIds: ['role-v1'], genericReferenceIds: [] }); expect(a.fingerprint).toBe(b.fingerprint); });
  it('keeps the frozen previous tail frame and flags over-capacity inputs without truncating them', () => {
    const result = resolveShotReferences({ subjectVersionIds: ['role-v1'], genericReferenceIds: [], previousTailFrameId: 'tail-1' });
    expect(result.orderedInputs).toEqual(['role-v1', 'tail-1']);
    const many = resolveShotReferences({ subjectVersionIds: Array.from({ length: 10 }, (_, index) => `role-${index}`), genericReferenceIds: [] });
    expect(many.orderedInputs).toHaveLength(10);
    expect(many.overCapacity).toBe(true);
  });
});
