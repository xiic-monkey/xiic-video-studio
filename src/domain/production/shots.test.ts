import { describe, expect, it } from 'vitest';
import { previewShotReplacement, shotSpecHash } from './shots';
describe('shot replacement', () => { it('asks for confirmation when retake is shorter', () => { const result = previewShotReplacement({ id: 'c', assetId: 'old', sourceInTicks: 0, sourceOutTicks: 100, }, { adoptionId: 'a', shotId: 's', slot: 'video', assetId: 'new', specHash: 'h', adoptedAt: '' }, { durationTicks: 50 }); expect(result.requiresConfirmation).toBe(true); expect(result.canKeepOut).toBe(false); }); });

describe('shot specification hash', () => {
  it('stays stable for same specification and changes when production inputs change', () => {
    const shot = { title: '相遇', action: '推门', dialogue: '你好', durationMs: 3000, bindings: [{ subjectId: 'hero', version: 2 }], revision: 1, review: 'draft', selected: {} };
    expect(shotSpecHash(shot)).toBe(shotSpecHash({ ...shot, revision: 9, review: 'approved', selected: { video: { assetId: 'asset-1' } } }));
    expect(shotSpecHash(shot)).not.toBe(shotSpecHash({ ...shot, action: '转身' }));
    expect(shotSpecHash(shot)).not.toBe(shotSpecHash({ ...shot, bindings: [{ subjectId: 'hero', version: 3 }] }));
  });
});
