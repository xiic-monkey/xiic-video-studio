import { describe, expect, it } from 'vitest';
import { describeReviewError, nextReviewStates } from './shotReview';

describe('shot review state machine', () => {
  it('goes through review before approving', () => {
    expect(nextReviewStates('draft')).toEqual(['review', 'approved']);
    expect(nextReviewStates(undefined)).toEqual(['review', 'approved']);
    expect(nextReviewStates('rejected')).toEqual(['review', 'approved']);
  });

  it('approves directly when the shot is already in review', () => {
    expect(nextReviewStates('review')).toEqual(['approved']);
  });

  it('explains a validation failure instead of failing silently', () => {
    expect(describeReviewError(new Error('PRODUCTION_VALIDATION_FAILED'))).toContain('PRODUCTION_VALIDATION_FAILED');
    expect(describeReviewError('boom')).toContain('boom');
  });
});
