import { describe, expect, it } from 'vitest';
import type { ModelCapability, ProviderProfile } from '../types';
import { catalogCapability } from './catalog';
import {
  autoModels, effectiveCapability, keyIsCooling, planRoute, protocolOf, providersForModel,
} from './routing';

function profile(
  id: string,
  models: ProviderProfile['models'],
  extra: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id,
    name: id,
    adapter: 'openai-compatible',
    baseUrl: 'https://example.com',
    auth: { type: 'bearer', keyRef: `provider/${id}` },
    models,
    enabled: true,
    schemaVersion: 2,
    keys: [{
      id: 'k1', label: '主 Key', keyRef: `provider/${id}/key/k1`,
      enabled: true, status: 'active', hasSecret: true,
    }],
    ...extra,
  };
}

const H3 = {
  id: 'MiniMax-H3',
  displayName: 'MiniMax H3',
  capabilities: [{ capability: 'video.generate', inputTransport: ['publicUrl'] as ModelCapability['inputTransport'], async: true }],
};

const profiles: ProviderProfile[] = [
  profile('official', [H3], { name: '官方' }),
  profile('relay', [{ ...H3, priority: 10 }], { name: '中转' }),
  profile('broken', [{ ...H3, priority: 1, enabled: false }], { name: '停用绑定' }),
  profile('disabled', [H3], { name: '停用供应商', enabled: false }),
];

describe('planRoute', () => {
  it('orders candidates by the model priority', () => {
    const plan = planRoute(profiles, 'MiniMax-H3', 'video.generate');
    expect(plan.candidates.map((item) => item.providerId)).toEqual(['relay', 'official']);
  });

  it('skips disabled providers and disabled bindings', () => {
    const plan = planRoute(profiles, 'MiniMax-H3', 'video.generate');
    expect(plan.candidates.some((item) => item.providerId === 'disabled')).toBe(false);
    expect(plan.candidates.some((item) => item.providerId === 'broken')).toBe(false);
  });

  it('pins the provider when one is selected', () => {
    const plan = planRoute(profiles, 'MiniMax-H3', 'video.generate', 'official');
    expect(plan.pinned).toBe(true);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].providerId).toBe('official');
  });

  it('drops keys that are disabled or invalid', () => {
    const withBadKey = profile('bad', [H3], {
      keys: [
        { id: 'k1', label: '坏 Key', keyRef: 'x', enabled: true, status: 'invalid', hasSecret: true },
        { id: 'k2', label: '好 Key', keyRef: 'y', enabled: true, status: 'active', hasSecret: true },
        { id: 'k3', label: '没存的', keyRef: 'z', enabled: true, status: 'active', hasSecret: false },
      ],
    });
    const plan = planRoute([withBadKey], 'MiniMax-H3', 'video.generate');
    expect(plan.candidates[0].keys.map((key) => key.id)).toEqual(['k2']);
  });

  it('drops cooling keys until their deadline passes', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const withCooling = profile('cool', [H3], {
      keys: [
        { id: 'k1', label: '冷却中', keyRef: 'x', enabled: true, status: 'cooling', cooldownUntil: future, hasSecret: true },
        { id: 'k2', label: '已过期', keyRef: 'y', enabled: true, status: 'cooling', cooldownUntil: past, hasSecret: true },
      ],
    });
    const plan = planRoute([withCooling], 'MiniMax-H3', 'video.generate');
    expect(plan.candidates[0].keys.map((key) => key.id)).toEqual(['k2']);
    expect(keyIsCooling(withCooling.keys![0])).toBe(true);
    expect(keyIsCooling(withCooling.keys![1])).toBe(false);
  });

  it('reports no candidate when the model supports another capability only', () => {
    expect(planRoute(profiles, 'MiniMax-H3', 'text.chat').candidates).toHaveLength(0);
  });
});

describe('protocolOf', () => {
  it('uses the binding override first', () => {
    const custom = profile('custom', [{ ...H3, protocols: { 'video.generate': 'seedance-video' } }]);
    expect(protocolOf(custom, custom.models[0], 'video.generate')).toBe('seedance-video');
  });

  it('falls back to the catalog recommendation', () => {
    const plain = profile('plain', [H3]);
    expect(protocolOf(plain, plain.models[0], 'video.generate')).toBe('minimax-video');
  });

  it('falls back to the legacy adapter for models outside the catalog', () => {
    const legacy = profile('legacy', [{
      id: 'my-model', displayName: '自建',
      capabilities: [{ capability: 'text.chat', inputTransport: ['dataUrl'] as ModelCapability['inputTransport'], async: false }],
    }]);
    expect(protocolOf(legacy, legacy.models[0], 'text.chat')).toBe('openai-chat');
  });
});

describe('effectiveCapability', () => {
  it('merges the catalog baseline with the binding', () => {
    const binding = {
      id: 'MiniMax-H3',
      displayName: 'MiniMax H3',
      capabilities: [{
        capability: 'video.generate',
        inputTransport: ['publicUrl'] as ModelCapability['inputTransport'],
        async: true,
        durations: { min: 4, max: 30, step: 1 },
      }],
    };
    const merged = effectiveCapability('MiniMax-H3', binding, 'video.generate');
    expect(merged?.durations).toEqual({ min: 4, max: 30, step: 1 });
    // 目录里没写的字段仍保留
    expect(merged?.ratios).toContain('9:16');
  });

  it('returns undefined when the binding does not declare the capability', () => {
    // 与后端一致：绑定里没有的能力项，后端会跳过这个供应商。
    const binding = {
      id: 'gpt-image-2.6-flare',
      displayName: 'GPT Image 2.6 Flare',
      capabilities: [{
        capability: 'image.generate',
        inputTransport: ['dataUrl'] as ModelCapability['inputTransport'],
        async: false,
      }],
    };
    expect(effectiveCapability('gpt-image-2.6-flare', binding, 'image.edit')).toBeUndefined();
    // 目录里有这项能力也不行：以前前端会把它列成可用，后端却直接跳过。
    expect(catalogCapability('gpt-image-2.6-flare', 'image.edit')).toBeTruthy();
    // 只有没有绑定对象时才回落目录基线。
    expect(effectiveCapability('gpt-image-2.6-flare', undefined, 'image.edit')).toBeTruthy();
  });
});

describe('autoModels / providersForModel', () => {
  it('lists candidate models by priority', () => {
    expect(autoModels(profiles, 'video.generate').map((item) => item.providerId)).toEqual(['relay', 'official']);
  });

  it('lists the providers offering a model', () => {
    expect(providersForModel(profiles, 'MiniMax-H3').map((item) => item.profile.id))
      .toEqual(['official', 'relay', 'broken', 'disabled']);
  });
});
