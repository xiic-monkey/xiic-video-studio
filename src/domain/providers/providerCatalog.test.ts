import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from '../types';
import {
  connectedModelIds,
  isCustomProvider,
  isProviderConnected,
  profileFromCustom,
  profileFromTemplate,
  providerTemplates,
  uniqueProviderId,
} from './providerCatalog';

function profile(patch: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1', name: '测试供应商', adapter: 'openai-compatible', baseUrl: 'https://example.com',
    auth: { type: 'bearer', keyRef: 'provider/p1' }, models: [], enabled: true, schemaVersion: 2,
    keys: [{ id: 'default', label: '默认 Key', keyRef: 'provider/p1/key/default', enabled: true, status: 'active', hasSecret: false }],
    ...patch,
  };
}

describe('供应商目录', () => {
  it('从模型目录派生供应商：OpenAI 提供 GPT 与 GPT Image', () => {
    const templates = providerTemplates();
    const openai = templates.find((template) => template.id === 'openai');
    expect(openai).toBeTruthy();
    expect(openai?.baseUrl).toBe('https://api.openai.com');
    expect(openai?.models.map((item) => item.id)).toContain('gpt-6-astra');
    expect(openai?.models.map((item) => item.id)).toContain('gpt-image-2.6-flare');
    // 中文供应商名也要有稳定 id。
    expect(templates.some((template) => template.id === 'volcengine-ark')).toBe(true);
    expect(templates.some((template) => template.id === 'xiaomi-mimo')).toBe(true);
  });

  it('接入即绑定：模型按目录建议挂上协议，并留一条空 Key', () => {
    const template = providerTemplates().find((item) => item.id === 'minimax')!;
    const created = profileFromTemplate(template, []);
    expect(created.id).toBe('minimax');
    expect(created.baseUrl).toBe(template.baseUrl);
    expect(created.keys).toHaveLength(1);
    expect(created.keys?.[0].hasSecret).toBe(false);
    const video = created.models.find((model) => model.id === 'MiniMax-H3');
    expect(video?.protocols?.['video.generate']).toBe('minimax-video');
  });

  it('id 撞车时加后缀，不覆盖已有配置', () => {
    const template = providerTemplates()[0];
    expect(uniqueProviderId(template.id, [])).toBe(template.id);
    expect(uniqueProviderId(template.id, [template.id])).toBe(`${template.id}-2`);
  });
});

describe('自定义供应商', () => {
  it('用户自己给名称和 Base URL，模型留空后加', () => {
    const created = profileFromCustom(
      { name: '我的网关', baseUrl: 'https://gw.example.com/v1', authType: 'bearer' },
      [],
    );
    expect(created.name).toBe('我的网关');
    expect(created.baseUrl).toBe('https://gw.example.com/v1');
    expect(created.models).toEqual([]);
    expect(created.keys?.[0].hasSecret).toBe(false);
    expect(created.auth.type).toBe('bearer');
  });

  it('id 撞车时加后缀，不覆盖已有配置', () => {
    const created = profileFromCustom(
      { name: 'My Proxy', baseUrl: 'https://a.example.com', authType: 'header' },
      ['my-proxy'],
    );
    expect(created.id).toBe('my-proxy-2');
    expect(created.auth.type).toBe('header');
  });

  it('中文名用主机名当 id，稳定可复现', () => {
    const created = profileFromCustom(
      { name: '我的推理网关', baseUrl: 'https://gw.example.com/v1', authType: 'bearer' },
      [],
    );
    expect(created.id).toBe('gw-example-com');
  });

  it('能认出目录外的供应商', () => {
    const custom = profileFromCustom({ name: 'My Proxy', baseUrl: 'https://a.example.com', authType: 'bearer' }, []);
    expect(isCustomProvider(custom)).toBe(true);
    const template = providerTemplates()[0];
    expect(isCustomProvider(profileFromTemplate(template, []))).toBe(false);
  });
});

describe('接入状态', () => {
  it('没有可用 Key 就算未接入', () => {
    expect(isProviderConnected(profile())).toBe(false);
    expect(isProviderConnected(profile({
      keys: [{ id: 'default', label: 'k', keyRef: 'r', enabled: true, status: 'invalid', hasSecret: true }],
    }))).toBe(false);
    expect(isProviderConnected(profile({
      keys: [{ id: 'default', label: 'k', keyRef: 'r', enabled: false, status: 'active', hasSecret: true }],
    }))).toBe(false);
    expect(isProviderConnected(profile({
      keys: [{ id: 'default', label: 'k', keyRef: 'r', enabled: true, status: 'active', hasSecret: true }],
    }))).toBe(true);
  });

  it('停用的供应商不算已接入', () => {
    expect(isProviderConnected(profile({
      enabled: false,
      keys: [{ id: 'default', label: 'k', keyRef: 'r', enabled: true, status: 'active', hasSecret: true }],
    }))).toBe(false);
  });

  it('已接入的模型 id 才进集合', () => {
    const connected = profile({
      id: 'a', name: 'A',
      keys: [{ id: 'default', label: 'k', keyRef: 'r', enabled: true, status: 'active', hasSecret: true }],
      models: [{ id: 'm1', displayName: 'M1', capabilities: [] }],
    });
    const pending = profile({ id: 'b', name: 'B', models: [{ id: 'm2', displayName: 'M2', capabilities: [] }] });
    expect([...connectedModelIds([connected, pending])]).toEqual(['m1']);
  });
});
