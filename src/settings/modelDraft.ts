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
  const price = uniformPrice(model);
  // token 计价草稿表达不了，价格字段留空：否则保存时会被当成「用户改过价」，
  // 把 token 计价改写成 request 计价，属于数据损坏。
  const unit: SimplePriceUnit | undefined = price && price.unit !== 'token' ? price.unit : undefined;
  return {
    id: model.id,
    displayName: model.displayName,
    capabilities: model.capabilities.map((item) => item.capability).filter(isSimpleCapability),
    priceAmount: unit === undefined ? undefined : price?.amount,
    priceUnit: unit ?? 'request',
  };
}

/**
 * 草稿只有一个价格字段，只有当模型所有带价能力的价格一致（unit 与 amount 都相同）时，
 * 这个字段才有无损的取值；价格不一致时返回 undefined，避免草稿把不同的价压平成一个。
 * amount 为 0 也是真实价格，不能当成「没有价格」。
 */
function uniformPrice(model: ModelConfig): PriceRule | undefined {
  const priced = model.capabilities
    .map((item) => item.price)
    .filter((price): price is PriceRule => price !== undefined);
  if (!priced.length) return undefined;
  const [first] = priced;
  const same = priced.every((price) => price.unit === first.unit && price.amount === first.amount);
  return same ? first : undefined;
}

export function modelFromDraft(draft: ModelDraft): ModelConfig {
  const id = draft.id.trim();
  // amount 为 0 也是真实价格，不能当成「没有价格」。
  const price: PriceRule | undefined = draft.priceAmount !== undefined
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
 * - 草稿勾选的简单能力按草稿合并，价格逐能力计算：用户改过价就用草稿价，没改过就沿用原能力自己的价；
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
  const baseline = uniformPrice(original);
  const changed = priceChanged(draft, baseline);
  const draftPrice: PriceRule | undefined = draft.priceAmount !== undefined
    ? { unit: draft.priceUnit, amount: draft.priceAmount, currency: 'USD' }
    : undefined;
  const simple: ModelCapability[] = draft.capabilities.map((capability) => {
    const previous = original.capabilities.find((item) => item.capability === capability);
    const transport: ModelCapability['inputTransport'] = previous && previous.inputTransport.length
      ? [...previous.inputTransport]
      : ['dataUrl'];
    const price = mergePrice(draftPrice, previous, changed);
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

/**
 * 判断草稿里的价格是不是用户改过的。草稿只有一个价格字段，合并时又拿不到编辑前的草稿，
 * 只能跟基线比对：
 * - 草稿没填价 → 没改；
 * - 基线有统一价且草稿价与它完全一致 → 草稿只是回显原值，没改；
 * - 其余情况（基线没有统一价而草稿填了价，或草稿价与基线不同） → 用户改过。
 */
function priceChanged(draft: ModelDraft, baseline: PriceRule | undefined): boolean {
  if (draft.priceAmount === undefined) return false;
  if (baseline && baseline.amount === draft.priceAmount && baseline.unit === draft.priceUnit) return false;
  return true;
}

/**
 * 价格逐能力计算：
 * - 原模型里已有的同名能力：用户改过价就换成草稿价（保留原币种），没改过就沿用它自己的价
 *   （原来没价就还是没价）；
 * - 原模型里没有的能力（用户新加的）没有原价可沿用，才用草稿价。
 */
function mergePrice(
  draftPrice: PriceRule | undefined,
  previous: ModelCapability | undefined,
  changed: boolean,
): PriceRule | undefined {
  if (!previous) return draftPrice;
  if (!changed || !draftPrice) return previous.price;
  return {
    unit: draftPrice.unit,
    amount: draftPrice.amount,
    currency: previous.price?.currency ?? 'USD',
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
