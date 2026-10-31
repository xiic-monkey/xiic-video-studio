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

function modelPrice(model: ModelConfig): PriceRule | undefined {
  return model.capabilities.find((item) => item.price)?.price;
}

/**
 * 草稿保存时与原模型合并：草稿表达不了的能力（video.generate 等非简单能力）原样保留，
 * 草稿里没有的模型也不删除，避免点一次「保存」就静默丢掉模型。
 */
export function mergeModelDrafts(original: ModelConfig[], drafts: ModelDraft[]): ModelConfig[] {
  const merged: ModelConfig[] = [];
  const consumed = new Set<string>();

  for (const model of original) {
    const draft = drafts.find((item) => item.id.trim() === model.id);
    if (!draft) {
      merged.push(model);
      continue;
    }
    consumed.add(model.id);
    const result = mergeDraft(draft, model);
    if (result) merged.push(result);
  }

  for (const draft of drafts) {
    const id = draft.id.trim();
    if (!id || consumed.has(id)) continue;
    consumed.add(id);
    const built = modelFromDraft(draft);
    if (built.capabilities.length > 0) merged.push(built);
  }

  return merged;
}

function mergeDraft(draft: ModelDraft, original: ModelConfig): ModelConfig | undefined {
  const id = draft.id.trim();
  const originalPrice = modelPrice(original);
  const price = draft.priceAmount && draft.priceAmount > 0
    ? { unit: draft.priceUnit, amount: draft.priceAmount, currency: originalPrice?.currency ?? 'USD' }
    : originalPrice;
  const simple: ModelCapability[] = draft.capabilities.map((item) => ({
    capability: item,
    inputTransport: ['dataUrl'],
    async: false,
    ...(price ? { price } : {}),
  }));
  const preserved = original.capabilities.filter((item) => !isSimpleCapability(item.capability));
  const capabilities = [...simple, ...preserved];
  if (!capabilities.length) return undefined;
  return {
    id,
    displayName: draft.displayName.trim() || id,
    capabilities,
    ...(original.defaults ? { defaults: original.defaults } : {}),
  };
}

export function capabilitySummary(item: ModelCapability): string {
  const parts = [item.capability];
  if (item.modes?.length) parts.push(item.modes.join('/'));
  if (item.durations) parts.push(`${item.durations.min}-${item.durations.max}s`);
  if (item.resolutions?.length) parts.push(item.resolutions.join('/'));
  if (item.inputTransport.length) parts.push(item.inputTransport.join('/'));
  return parts.join(' · ');
}
