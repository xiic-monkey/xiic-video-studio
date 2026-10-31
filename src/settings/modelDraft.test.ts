import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../domain/types';
import {
  draftFromModel,
  emptyModelDraft,
  mergeModelDrafts,
  modelFromDraft,
  validDrafts,
} from './modelDraft';

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

const videoModel: ModelConfig = {
  id: 'h3-video',
  displayName: 'H3 视频',
  capabilities: [
    {
      capability: 'video.generate',
      modes: ['t2v', 'firstLast'],
      durations: { min: 5, max: 15, step: 1 },
      resolutions: ['768P', '2K'],
      inputTransport: ['publicUrl'],
      async: true,
      price: { unit: 'second', amount: 0.1, currency: 'USD' },
    },
  ],
  defaults: { protocol: 'official' },
};

const chatModel: ModelConfig = {
  id: 'gpt-4o-mini',
  displayName: 'GPT-4o mini',
  capabilities: [
    {
      capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
      price: { unit: 'request', amount: 0.01, currency: 'USD' },
    },
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

describe('model draft merge', () => {
  it('keeps models the draft cannot express', () => {
    const merged = mergeModelDrafts(
      [videoModel, chatModel],
      [draftFromModel(videoModel), draftFromModel(chatModel)],
    );
    expect(merged.map((item) => item.id)).toEqual(['h3-video', 'gpt-4o-mini']);

    const video = merged.find((item) => item.id === 'h3-video');
    expect(video).toBeDefined();
    expect(video?.capabilities).toHaveLength(1);
    expect(video?.capabilities[0].capability).toBe('video.generate');
    expect(video?.capabilities[0].modes).toEqual(['t2v', 'firstLast']);
    expect(video?.capabilities[0].durations).toEqual({ min: 5, max: 15, step: 1 });
    expect(video?.capabilities[0].resolutions).toEqual(['768P', '2K']);
    expect(video?.capabilities[0].inputTransport).toEqual(['publicUrl']);
    expect(video?.capabilities[0].async).toBe(true);
    expect(video?.capabilities[0].price).toEqual({ unit: 'second', amount: 0.1, currency: 'USD' });
    expect(video?.defaults).toEqual({ protocol: 'official' });
  });

  it('drops models missing from the draft list', () => {
    const merged = mergeModelDrafts([videoModel, chatModel], [draftFromModel(chatModel)]);
    expect(merged.map((item) => item.id)).toEqual(['gpt-4o-mini']);
  });

  it('applies draft edits on top of the original model', () => {
    const merged = mergeModelDrafts([chatModel], [{
      id: '  gpt-4o-mini ', displayName: '  ', capabilities: ['text.chat', 'image.generate'],
      priceAmount: 0.04, priceUnit: 'image',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('gpt-4o-mini');
    expect(merged[0].displayName).toBe('gpt-4o-mini');
    expect(merged[0].capabilities.map((item) => item.capability)).toEqual(['text.chat', 'image.generate']);
    // 已存在的 text.chat 保留自己的价，草稿价只给新增的 image.generate。
    expect(merged[0].capabilities[0].price).toEqual({ unit: 'request', amount: 0.01, currency: 'USD' });
    expect(merged[0].capabilities[1].price).toEqual({ unit: 'image', amount: 0.04, currency: 'USD' });
  });

  it('keeps the original currency and falls back to the original price', () => {
    const cnyModel: ModelConfig = {
      id: 'cny-chat',
      displayName: 'CNY 模型',
      capabilities: [
        {
          capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
          price: { unit: 'request', amount: 0.02, currency: 'CNY' },
        },
      ],
    };
    const priced = mergeModelDrafts([cnyModel], [{
      id: 'cny-chat', displayName: 'CNY 模型', capabilities: ['text.chat'],
      priceAmount: 0.05, priceUnit: 'request',
    }]);
    expect(priced[0].capabilities[0].price).toEqual({ unit: 'request', amount: 0.02, currency: 'CNY' });

    const unpriced = mergeModelDrafts([cnyModel], [{
      id: 'cny-chat', displayName: 'CNY 模型', capabilities: ['text.chat'], priceUnit: 'request',
    }]);
    expect(unpriced[0].capabilities[0].price).toEqual({ unit: 'request', amount: 0.02, currency: 'CNY' });
  });

  it('appends models the draft added', () => {
    const merged = mergeModelDrafts([chatModel], [
      draftFromModel(chatModel),
      { id: 'new-image', displayName: '', capabilities: ['image.generate'], priceAmount: 0.04, priceUnit: 'image' },
    ]);
    expect(merged.map((item) => item.id)).toEqual(['gpt-4o-mini', 'new-image']);
    expect(merged[1].displayName).toBe('new-image');
    expect(merged[1].capabilities[0].price).toEqual({ unit: 'image', amount: 0.04, currency: 'USD' });
  });
});

const mixedModel: ModelConfig = {
  id: 'mixed',
  displayName: '混合模型',
  capabilities: [
    {
      capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
      price: { unit: 'request', amount: 0.01, currency: 'USD' },
    },
    {
      capability: 'video.generate',
      modes: ['t2v', 'firstLast'],
      durations: { min: 5, max: 15, step: 1 },
      resolutions: ['768P', '2K'],
      inputTransport: ['publicUrl'],
      async: true,
      price: { unit: 'second', amount: 0.2, currency: 'USD' },
    },
  ],
};

describe('model draft merge semantics', () => {
  it('removes a model the user deleted from the draft list', () => {
    const merged = mergeModelDrafts([videoModel, chatModel], [draftFromModel(chatModel)]);
    expect(merged.map((item) => item.id)).toEqual(['gpt-4o-mini']);
    expect(merged.some((item) => item.id === 'h3-video')).toBe(false);
  });

  it('renames a model instead of keeping a copy of the old id', () => {
    const merged = mergeModelDrafts([chatModel], [{ ...draftFromModel(chatModel), id: 'gpt-4o' }]);
    expect(merged.map((item) => item.id)).toEqual(['gpt-4o']);
    expect(merged.some((item) => item.id === 'gpt-4o-mini')).toBe(false);
    expect(merged[0].displayName).toBe('GPT-4o mini');
    expect(merged[0].capabilities[0].price).toEqual({ unit: 'request', amount: 0.01, currency: 'USD' });
  });

  it('keeps non-simple capabilities and every field of them', () => {
    const merged = mergeModelDrafts([mixedModel], [{
      id: 'mixed', displayName: '混合模型', capabilities: ['text.chat'], priceAmount: 0.03, priceUnit: 'request',
    }]);
    expect(merged).toHaveLength(1);

    const video = merged[0].capabilities.find((item) => item.capability === 'video.generate');
    expect(video?.modes).toEqual(['t2v', 'firstLast']);
    expect(video?.durations).toEqual({ min: 5, max: 15, step: 1 });
    expect(video?.resolutions).toEqual(['768P', '2K']);
    expect(video?.inputTransport).toEqual(['publicUrl']);
    expect(video?.async).toBe(true);
  });

  it('keeps each simple capability its own price', () => {
    const priced: ModelConfig = {
      id: 'multi',
      displayName: '多能力模型',
      capabilities: [
        {
          capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
          price: { unit: 'request', amount: 0.01, currency: 'USD' },
        },
        {
          capability: 'image.generate', inputTransport: ['dataUrl'], async: false,
          price: { unit: 'image', amount: 0.04, currency: 'USD' },
        },
      ],
    };
    const merged = mergeModelDrafts([priced], [{
      id: 'multi', displayName: '多能力模型', capabilities: ['text.chat', 'image.generate'], priceUnit: 'request',
    }]);
    expect(merged).toHaveLength(1);
    const chat = merged[0].capabilities.find((item) => item.capability === 'text.chat');
    const image = merged[0].capabilities.find((item) => item.capability === 'image.generate');
    expect(chat?.price).toEqual({ unit: 'request', amount: 0.01, currency: 'USD' });
    expect(image?.price).toEqual({ unit: 'image', amount: 0.04, currency: 'USD' });
  });

  it('does not overwrite an existing capability price with the draft price', () => {
    const merged = mergeModelDrafts([mixedModel], [{
      id: 'mixed', displayName: '混合模型', capabilities: ['text.chat'], priceAmount: 0.03, priceUnit: 'request',
    }]);
    const chat = merged[0].capabilities.find((item) => item.capability === 'text.chat');
    const video = merged[0].capabilities.find((item) => item.capability === 'video.generate');
    expect(chat?.price).toEqual({ unit: 'request', amount: 0.01, currency: 'USD' });
    expect(video?.price).toEqual({ unit: 'second', amount: 0.2, currency: 'USD' });
  });

  it('reuses the original inputTransport and async of a simple capability', () => {
    const uploaded: ModelConfig = {
      id: 'uploaded',
      displayName: '上传模型',
      capabilities: [{ capability: 'image.edit', inputTransport: ['upload'], async: true }],
    };
    const merged = mergeModelDrafts([uploaded], [{
      id: 'uploaded', displayName: '上传模型', capabilities: ['image.edit'], priceUnit: 'image',
    }]);
    expect(merged[0].capabilities[0].inputTransport).toEqual(['upload']);
    expect(merged[0].capabilities[0].async).toBe(true);
  });

  it('removes simple capabilities the user unchecked but keeps the other ones', () => {
    const merged = mergeModelDrafts([mixedModel], [{
      id: 'mixed', displayName: '混合模型', capabilities: ['image.generate'], priceUnit: 'request',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].capabilities.map((item) => item.capability)).toEqual(['image.generate', 'video.generate']);
  });

  it('drops a model whose merged capabilities are empty', () => {
    const merged = mergeModelDrafts([chatModel], [{
      id: 'gpt-4o-mini', displayName: 'GPT-4o mini', capabilities: [], priceUnit: 'request',
    }]);
    expect(merged).toHaveLength(0);
  });
});

const multiPriceModel: ModelConfig = {
  id: 'multi-price',
  displayName: '多价模型',
  capabilities: [
    {
      capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
      price: { unit: 'request', amount: 0.01, currency: 'USD' },
    },
    {
      capability: 'image.generate', inputTransport: ['dataUrl'], async: false,
      price: { unit: 'image', amount: 0.04, currency: 'USD' },
    },
  ],
};

const singlePriceModel: ModelConfig = {
  id: 'single-price',
  displayName: '单价模型',
  capabilities: [
    {
      capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
      price: { unit: 'request', amount: 0.01, currency: 'USD' },
    },
    { capability: 'image.generate', inputTransport: ['dataUrl'], async: false },
  ],
};

describe('model draft price consistency', () => {
  it('leaves the draft price empty when the priced capabilities disagree', () => {
    const draft = draftFromModel(multiPriceModel);
    expect(draft.capabilities).toEqual(['text.chat', 'image.generate']);
    expect(draft.priceAmount).toBeUndefined();
    expect(draft.priceUnit).toBe('request');
  });

  it('keeps every capability price when the draft is saved without edits', () => {
    const merged = mergeModelDrafts([multiPriceModel], [draftFromModel(multiPriceModel)]);
    expect(merged).toHaveLength(1);
    const chat = merged[0].capabilities.find((item) => item.capability === 'text.chat');
    const image = merged[0].capabilities.find((item) => item.capability === 'image.generate');
    expect(chat?.price).toEqual({ unit: 'request', amount: 0.01, currency: 'USD' });
    expect(image?.price).toEqual({ unit: 'image', amount: 0.04, currency: 'USD' });
  });

  it('shows the price when only one capability is priced', () => {
    const draft = draftFromModel(singlePriceModel);
    expect(draft.priceAmount).toBe(0.01);
    expect(draft.priceUnit).toBe('request');
  });

  it('does not add a price to an existing capability that had none', () => {
    const merged = mergeModelDrafts([singlePriceModel], [{
      ...draftFromModel(singlePriceModel),
      priceAmount: 0.02,
    }]);
    const chat = merged[0].capabilities.find((item) => item.capability === 'text.chat');
    const image = merged[0].capabilities.find((item) => item.capability === 'image.generate');
    expect(chat?.price).toEqual({ unit: 'request', amount: 0.01, currency: 'USD' });
    expect(image?.price).toBeUndefined();
  });

  it('gives the draft price to a new capability but keeps the existing prices', () => {
    const merged = mergeModelDrafts([multiPriceModel], [{
      ...draftFromModel(multiPriceModel),
      capabilities: ['text.chat', 'image.generate', 'audio.tts'],
      priceAmount: 0.02,
      priceUnit: 'request',
    }]);
    expect(merged).toHaveLength(1);
    const chat = merged[0].capabilities.find((item) => item.capability === 'text.chat');
    const image = merged[0].capabilities.find((item) => item.capability === 'image.generate');
    const tts = merged[0].capabilities.find((item) => item.capability === 'audio.tts');
    expect(chat?.price).toEqual({ unit: 'request', amount: 0.01, currency: 'USD' });
    expect(image?.price).toEqual({ unit: 'image', amount: 0.04, currency: 'USD' });
    expect(tts?.price).toEqual({ unit: 'request', amount: 0.02, currency: 'USD' });
  });

  it('fills the draft price when every priced capability shares the same price', () => {
    const uniform: ModelConfig = {
      id: 'uniform',
      displayName: '同价模型',
      capabilities: [
        {
          capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
          price: { unit: 'request', amount: 0.01, currency: 'USD' },
        },
        {
          capability: 'image.generate', inputTransport: ['dataUrl'], async: false,
          price: { unit: 'request', amount: 0.01, currency: 'USD' },
        },
      ],
    };
    const draft = draftFromModel(uniform);
    expect(draft.priceAmount).toBe(0.01);
    expect(draft.priceUnit).toBe('request');
  });

  it('keeps a zero price instead of treating it as missing', () => {
    const free: ModelConfig = {
      id: 'free',
      displayName: '免费模型',
      capabilities: [
        {
          capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
          price: { unit: 'request', amount: 0, currency: 'USD' },
        },
      ],
    };
    const draft = draftFromModel(free);
    expect(draft.priceAmount).toBe(0);

    const merged = mergeModelDrafts([free], [draft]);
    expect(merged[0].capabilities[0].price).toEqual({ unit: 'request', amount: 0, currency: 'USD' });
  });
});
