import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from '../domain/types';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { capabilityForNode, capabilityLabel, modelOptions } from './model';

const capability = (name: string) => ({ capability: name, inputTransport: ['dataUrl'] as const, async: false });

const profiles: ProviderProfile[] = [
  {
    id: 'oai', name: 'OpenAI 兼容', adapter: 'openai-compatible', baseUrl: 'https://example.com',
    auth: { type: 'bearer', keyRef: 'provider/oai' }, enabled: true, schemaVersion: 1,
    models: [{ id: 'gpt', displayName: 'GPT', capabilities: [{ ...capability('text.chat'), inputTransport: ['dataUrl'] }] }],
  },
  {
    id: 'off', name: '停用', adapter: 'openai-compatible', baseUrl: '',
    auth: { type: 'bearer', keyRef: 'provider/off' }, enabled: false, schemaVersion: 1,
    models: [{ id: 'x', displayName: 'X', capabilities: [{ ...capability('text.chat'), inputTransport: ['dataUrl'] }] }],
  },
];

describe('model capability routing', () => {
  it('lists enabled models by capability', () => {
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
