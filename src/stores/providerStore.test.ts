import { describe, expect, it } from 'vitest';
import { syncCatalogCapabilities } from './providerStore';
import type { ModelCapability, ProviderProfile } from '../domain/types';

function profile(capabilities: ModelCapability[]): ProviderProfile {
  return {
    id: 'openai-compatible',
    name: 'OpenAI 兼容中转',
    adapter: 'openai-compatible',
    baseUrl: 'https://relay.example/v1',
    auth: { type: 'bearer', keyRef: 'provider/openai-compatible' },
    enabled: true,
    schemaVersion: 2,
    models: [{
      id: 'gpt-image-2.6-flare',
      displayName: 'GPT Image 2.6 Flare',
      capabilities,
    }],
  };
}

describe('syncCatalogCapabilities', () => {
  it('补齐目录新增的能力，不动已有的覆盖值', () => {
    const { profile: synced, changed } = syncCatalogCapabilities(profile([
      { capability: 'image.generate', inputTransport: ['dataUrl'], async: false },
    ]));
    expect(changed).toBe(true);
    const capabilities = synced.models[0].capabilities;
    expect(capabilities.map((item) => item.capability)).toContain('image.generate');
    // 目录里的 image.edit 被补上了。
    expect(capabilities.map((item) => item.capability)).toContain('image.edit');
  });

  it('能力齐全时不动配置', () => {
    const input = profile([
      { capability: 'image.generate', inputTransport: ['dataUrl'], async: false },
      { capability: 'image.edit', inputTransport: ['dataUrl'], async: false },
    ]);
    const { profile: synced, changed } = syncCatalogCapabilities(input);
    expect(changed).toBe(false);
    expect(synced).toBe(input);
  });

  it('目录里没有的模型不处理', () => {
    const input = profile([{ capability: 'image.generate', inputTransport: ['dataUrl'], async: false }]);
    const custom = { ...input, models: [{ ...input.models[0], id: 'my-own-model' }] };
    const { changed } = syncCatalogCapabilities(custom);
    expect(changed).toBe(false);
  });
});
