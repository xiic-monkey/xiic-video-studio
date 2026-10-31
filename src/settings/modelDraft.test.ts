import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../domain/types';
import { draftFromModel, emptyModelDraft, modelFromDraft, validDrafts } from './modelDraft';

const model: ModelConfig = {
  id: 'gpt-4o-mini',
  displayName: 'GPT-4o mini',
  capabilities: [
    {
      capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
      price: { unit: 'request', amount: 0.01, currency: 'USD' },
    },
    { capability: 'video.generate', inputTransport: ['publicUrl'], async: true },
  ],
};

describe('model drafts', () => {
  it('keeps simple capabilities and price', () => {
    const draft = draftFromModel(model);
    expect(draft.capabilities).toEqual(['text.chat']);
    expect(draft.priceAmount).toBe(0.01);
    expect(draft.priceUnit).toBe('request');
  });

  it('builds a model with trimmed id and fallback display name', () => {
    const built = modelFromDraft({
      id: '  gpt-image-1 ', displayName: '  ', capabilities: ['image.generate'],
      priceAmount: 0.04, priceUnit: 'image',
    });
    expect(built.id).toBe('gpt-image-1');
    expect(built.displayName).toBe('gpt-image-1');
    expect(built.capabilities[0].price).toEqual({ unit: 'image', amount: 0.04, currency: 'USD' });
  });

  it('drops drafts without an id', () => {
    expect(validDrafts([emptyModelDraft(), { ...emptyModelDraft(), id: 'x' }])).toHaveLength(1);
  });
});
