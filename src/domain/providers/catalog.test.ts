import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  PROTOCOL_IDS,
  TEXT_PROTOCOL_PARAM_MAP,
  capabilityProtocols,
  catalogCapability,
  catalogModel,
  catalogModelsFor,
  catalogParamOptions,
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

  it('declares the ark image submit path for seedream', () => {
    // 火山方舟的图片接口在 /api/v3 下，不是 /v1。
    expect(catalogModel('seedream-4.0')?.defaults?.submitPath).toBe('/api/v3/images/generations');
  });

  it('maps the params each text protocol can read', () => {
    expect(TEXT_PROTOCOL_PARAM_MAP['openai-chat']).toEqual(['temperature', 'maxTokens']);
    expect(TEXT_PROTOCOL_PARAM_MAP['anthropic-messages']).toEqual(['temperature', 'maxTokens']);
  });

  it('exposes the catalog param options and defaults', () => {
    const options = catalogParamOptions('doubao-seedance-1-0-pro-250528', 'video.generate', 'resolution');
    expect(options?.map((option) => option.value)).toEqual(['480p', '720p', '1080p']);
    // 没有选项的参数返回 undefined。
    expect(catalogParamOptions('gpt-4o-mini', 'text.chat', 'temperature')).toBeUndefined();
  });

  it('marks seedance as a model without native audio', () => {
    expect(catalogCapability('doubao-seedance-1-0-pro-250528', 'video.generate')?.supportsNativeAudio).toBe(false);
    expect(catalogCapability('MiniMax-H3', 'video.generate')?.supportsNativeAudio).toBe(true);
  });
});
