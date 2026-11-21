import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  PROTOCOL_IDS,
  capabilityProtocols,
  catalogCapability,
  catalogModelsFor,
  catalogParams,
  protocolLabel,
} from './catalog';

const TRANSPORTS = ['dataUrl', 'publicUrl', 'upload', 'multipart'];

describe('model catalog', () => {
  it('has unique model ids', () => {
    const ids = CATALOG.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks GPT Image as the mask-capable edit model', () => {
    expect(catalogCapability('gpt-image-1', 'image.edit')?.supportsMask).toBe(true);
    expect(catalogCapability('qwen-image', 'image.edit')?.supportsMask).toBeUndefined();
  });

  it('gives every capability a non-empty and valid protocol list', () => {
    for (const model of CATALOG) {
      for (const capability of model.capabilities) {
        expect(capability.protocols, `${model.id}/${capability.capability}`).toBeTruthy();
        expect(capability.protocols!.length).toBeGreaterThan(0);
        for (const protocol of capability.protocols!) {
          expect(PROTOCOL_IDS).toContain(protocol);
        }
      }
    }
  });

  it('only uses known input transports', () => {
    for (const model of CATALOG) {
      for (const capability of model.capabilities) {
        expect(Array.isArray(capability.inputTransport)).toBe(true);
        for (const transport of capability.inputTransport) {
          expect(TRANSPORTS).toContain(transport);
        }
      }
    }
  });

  it('declares durations and ratios for video models', () => {
    for (const model of catalogModelsFor('video.generate')) {
      const capability = catalogCapability(model.id, 'video.generate')!;
      expect(capability.durations, model.id).toBeTruthy();
      expect(capability.ratios, model.id).toBeTruthy();
      expect(capability.ratios!.length).toBeGreaterThan(0);
    }
  });

  it('lists the built-in video models', () => {
    const ids = catalogModelsFor('video.generate').map((model) => model.id);
    expect(ids).toContain('MiniMax-H3');
    expect(ids).toContain('doubao-seedance-1-0-pro-250528');
  });

  it('returns the video params of MiniMax H3', () => {
    const keys = catalogParams('MiniMax-H3', 'video.generate').map((param) => param.key);
    expect(keys).toEqual(['duration', 'resolution', 'aspectRatio', 'generateAudio']);
  });

  it('exposes openai-chat for gpt-4o-mini text chat', () => {
    const capability = catalogCapability('gpt-4o-mini', 'text.chat')!;
    expect(capability.protocols).toContain('openai-chat');
    expect(capabilityProtocols('gpt-4o-mini', 'text.chat')).toContain('openai-chat');
  });

  it('labels every protocol in Chinese', () => {
    for (const protocol of PROTOCOL_IDS) {
      const label = protocolLabel(protocol);
      expect(label.length, protocol).toBeGreaterThan(0);
      expect(label, protocol).not.toBe(protocol);
    }
  });
});
