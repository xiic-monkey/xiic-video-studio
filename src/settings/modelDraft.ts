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

export function capabilitySummary(item: ModelCapability): string {
  const parts = [item.capability];
  if (item.modes?.length) parts.push(item.modes.join('/'));
  if (item.durations) parts.push(`${item.durations.min}-${item.durations.max}s`);
  if (item.resolutions?.length) parts.push(item.resolutions.join('/'));
  if (item.inputTransport.length) parts.push(item.inputTransport.join('/'));
  return parts.join(' · ');
}
