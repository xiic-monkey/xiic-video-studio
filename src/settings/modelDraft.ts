import type { ModelCapability, ModelConfig, PriceRule } from '../domain/types';

export type SimpleCapability = 'text.chat' | 'image.generate' | 'image.edit' | 'audio.tts';
export type SimplePriceUnit = 'request' | 'image' | 'second' | 'character';

export interface ModelDraft {
  id: string;
  displayName: string;
  capabilities: SimpleCapability[];
  priceAmount?: number;
  priceUnit: SimplePriceUnit;
}

export const SIMPLE_CAPABILITIES: Array<{ value: SimpleCapability; label: string }> = [
  { value: 'text.chat', label: '文本' },
  { value: 'image.generate', label: '生图' },
  { value: 'image.edit', label: '改图' },
  { value: 'audio.tts', label: '语音' },
];

const SIMPLE_SET = new Set<string>(SIMPLE_CAPABILITIES.map((item) => item.value));

export function isSimpleCapability(value: string): value is SimpleCapability {
  return SIMPLE_SET.has(value);
}

export function draftFromModel(model: ModelConfig): ModelDraft {
  const firstPrice = model.capabilities.find((item) => item.price)?.price;
  return {
    id: model.id,
    displayName: model.displayName,
    capabilities: model.capabilities.map((item) => item.capability).filter(isSimpleCapability),
    priceAmount: firstPrice?.amount,
    priceUnit: firstPrice && firstPrice.unit !== 'token' ? firstPrice.unit : 'request',
  };
}

export function modelFromDraft(draft: ModelDraft): ModelConfig {
  const id = draft.id.trim();
  const price: PriceRule | undefined = draft.priceAmount && draft.priceAmount > 0
    ? { unit: draft.priceUnit, amount: draft.priceAmount, currency: 'USD' }
    : undefined;
  const capabilities: ModelCapability[] = draft.capabilities.map((item) => ({
    capability: item,
    inputTransport: ['dataUrl'],
    async: false,
    ...(price ? { price } : {}),
  }));
  return { id, displayName: draft.displayName.trim() || id, capabilities };
}

export function emptyModelDraft(): ModelDraft {
  return { id: '', displayName: '', capabilities: ['text.chat'], priceUnit: 'request' };
}

export function validDrafts(drafts: ModelDraft[]): ModelConfig[] {
  return drafts
    .map(modelFromDraft)
    .filter((model) => model.id.length > 0 && model.capabilities.length > 0);
}

/**
 * 草稿保存时与原模型合并。草稿是原模型的全量视图，因此：
 * - 基线里有、当前草稿里没有的 id = 用户删除或改名，这些模型不再保留；
 * - 草稿勾选的简单能力按草稿合并，价格逐能力计算；
 * - 草稿表达不了的非简单能力（video.generate 等）原样保留，字段一个不丢。
 */
export function mergeModelDrafts(original: ModelConfig[], drafts: ModelDraft[]): ModelConfig[] {
  const baseline = new Map(original.map((model) => [model.id, model]));
  const merged: ModelConfig[] = [];
  const used = new Set<string>();

  for (const draft of drafts) {
    const id = draft.id.trim();
    if (!id || used.has(id)) continue;
    used.add(id);
    const base = baseline.get(id);
    const model = base ? mergeDraft(draft, base) : modelFromDraft(draft);
    if (model.capabilities.length > 0) merged.push(model);
  }

  return merged;
}

function mergeDraft(draft: ModelDraft, original: ModelConfig): ModelConfig {
  const id = draft.id.trim();
  const simple: ModelCapability[] = draft.capabilities.map((capability) => {
    const previous = original.capabilities.find((item) => item.capability === capability);
    const transport: ModelCapability['inputTransport'] = previous && previous.inputTransport.length
      ? [...previous.inputTransport]
      : ['dataUrl'];
    const price = mergePrice(draft, previous);
    return {
      capability,
      inputTransport: transport,
      async: previous?.async ?? false,
      ...(price ? { price } : {}),
    };
  });
  const preserved = original.capabilities.filter((item) => !isSimpleCapability(item.capability));
  const capabilities = [...simple, ...preserved];
  return {
    id,
    displayName: draft.displayName.trim() || id,
    capabilities,
    ...(original.defaults ? { defaults: original.defaults } : {}),
  };
}

/** 价格逐能力计算：草稿填了价就用草稿的，没填就沿用原同名能力自己的价。 */
function mergePrice(draft: ModelDraft, previous: ModelCapability | undefined): PriceRule | undefined {
  if (draft.priceAmount !== undefined && draft.priceAmount > 0) {
    return {
      unit: draft.priceUnit,
      amount: draft.priceAmount,
      currency: previous?.price?.currency ?? 'USD',
    };
  }
  return previous?.price;
}

export function capabilitySummary(item: ModelCapability): string {
  const parts = [item.capability];
  if (item.modes?.length) parts.push(item.modes.join('/'));
  if (item.durations) parts.push(`${item.durations.min}-${item.durations.max}s`);
  if (item.resolutions?.length) parts.push(item.resolutions.join('/'));
  if (item.inputTransport.length) parts.push(item.inputTransport.join('/'));
  return parts.join(' · ');
}
