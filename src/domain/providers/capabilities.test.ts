import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, MINIMAX_H3_MODEL, capabilityOf, estimateCost } from './capabilities';

describe('provider defaults', () => {
  it('ships an H3 model with the documented limits', () => {
    const capability = capabilityOf(MINIMAX_H3_MODEL, 'video.generate')!;
    expect(capability.durations).toEqual({ min: 5, max: 15, step: 1 });
    expect(capability.resolutions).toEqual(['768P', '2K']);
    expect(capability.maxReferenceImages).toBe(9);
    expect(capability.maxReferenceVideos).toBe(3);
    expect(capability.maxReferenceAudios).toBe(3);
    expect(capability.inputTransport).toEqual(['publicUrl']);
  });

  it('includes an openai-compatible and an H3 profile', () => {
    expect(DEFAULT_PROVIDERS.map((profile) => profile.adapter)).toEqual(['openai-compatible', 'minimax-h3']);
  });

  it('estimates per-second video cost when a price exists', () => {
    const model = {
      ...MINIMAX_H3_MODEL,
      capabilities: MINIMAX_H3_MODEL.capabilities.map((item) => item.capability === 'video.generate'
        ? { ...item, price: { unit: 'second' as const, amount: 0.5, currency: 'CNY' } }
        : item),
    };
    expect(estimateCost(model, 'video.generate', { duration: 10 })).toMatchObject({ amount: 5, currency: 'CNY' });
  });

  it('returns undefined when no price is configured', () => {
    expect(estimateCost(MINIMAX_H3_MODEL, 'video.generate', { duration: 10 })).toBeUndefined();
  });
});
