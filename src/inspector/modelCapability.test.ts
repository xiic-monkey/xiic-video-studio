import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from '../domain/types';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { capabilityForNode, capabilityLabel, modelOptions } from './model';

const capability = (name: string) => ({ capability: name, inputTransport: ['dataUrl'] as const, async: false });

const profiles: ProviderProfile[] = [
  {
    id: 'oai', name: 'OpenAI 兼容', adapter: 'openai-compatible', baseUrl: 'https://example.com',
    auth: { type: 'bearer', keyRef: 'provider/oai' }, enabled: true, schemaVersion: 2,
    keys: [{ id: 'default', label: '默认 Key', keyRef: 'provider/oai/key/default', enabled: true, status: 'active', hasSecret: true }],
    models: [{ id: 'gpt', displayName: 'GPT', capabilities: [{ ...capability('text.chat'), inputTransport: ['dataUrl'] }] }],
  },
  {
    id: 'nokey', name: '还没配 Key', adapter: 'openai-compatible', baseUrl: '',
    auth: { type: 'bearer', keyRef: 'provider/nokey' }, enabled: true, schemaVersion: 2,
    keys: [{ id: 'default', label: '默认 Key', keyRef: 'provider/nokey/key/default', enabled: true, status: 'active', hasSecret: false }],
    models: [{ id: 'y', displayName: 'Y', capabilities: [{ ...capability('text.chat'), inputTransport: ['dataUrl'] }] }],
  },
  {
    id: 'off', name: '停用', adapter: 'openai-compatible', baseUrl: '',
    auth: { type: 'bearer', keyRef: 'provider/off' }, enabled: false, schemaVersion: 2,
    keys: [{ id: 'default', label: '默认 Key', keyRef: 'provider/off/key/default', enabled: true, status: 'active', hasSecret: true }],
    models: [{ id: 'x', displayName: 'X', capabilities: [{ ...capability('text.chat'), inputTransport: ['dataUrl'] }] }],
  },
];

describe('model capability routing', () => {
  it('只列出已接入供应商的模型', () => {
    // 停了用的（off）和没配 Key 的（nokey）都不该出现：
    // 模型列表里摆一个跑不起来的选项，只会把问题拖到运行那一刻。
    expect(modelOptions(profiles, 'text.chat')).toEqual([
      { providerId: 'oai', providerName: 'OpenAI 兼容', modelId: 'gpt', modelName: 'GPT' },
    ]);
    expect(modelOptions(profiles, 'video.generate')).toEqual([]);
  });

  it('maps node types and reference ports to capabilities', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('i', 'image'), node('v', 'video'), node('a', 'audio'), node('e', 'image')],
      [
        edge('e1', 't', 'e'),
        edge('e2', 'i', 'e', 'image', 'references', 'reference_image'),
      ],
    );
    expect(capabilityForNode(doc, doc.nodes.t)).toBe('text.chat');
    expect(capabilityForNode(doc, doc.nodes.i)).toBe('image.generate');
    expect(capabilityForNode(doc, doc.nodes.v)).toBe('video.generate');
    expect(capabilityForNode(doc, doc.nodes.a)).toBe('audio.tts');
    expect(capabilityForNode(doc, doc.nodes.e)).toBe('image.edit');
  });

  it('labels capabilities in Chinese', () => {
    expect(capabilityLabel('video.generate')).toBe('视频生成');
    expect(capabilityLabel('unknown.cap')).toBe('unknown.cap');
  });
});
