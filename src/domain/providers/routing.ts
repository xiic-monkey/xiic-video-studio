import type { FieldDef } from '../nodes/types';
import type {
  ModelCapability, ModelConfig, ParamDef, ProtocolId, ProviderKey, ProviderProfile,
} from '../types';
import { catalogCapability, catalogModel, catalogParams } from './catalog';

/** 旧适配器名 → 默认协议。绑定里显式配了 protocols 就用绑定值。 */
export function legacyProtocol(adapter: string, capability: string): ProtocolId {
  if (capability === 'text.chat') return 'openai-chat';
  if (capability === 'image.generate' || capability === 'image.edit') return 'openai-images';
  if (capability === 'audio.tts') return 'openai-audio';
  if (adapter === 'bytedance-video') return 'seedance-video';
  return 'minimax-video';
}

/** 一个候选：某供应商提供的某模型，用某个协议调用。 */
export interface RouteCandidate {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  protocol: ProtocolId;
  /** 该模型下跨供应商的顺序，数字小的先调用。 */
  priority: number;
  /** 该供应商下可用的 Key（按顺序尝试）。 */
  keys: Array<{ id: string; label: string }>;
  binding: ModelConfig;
}

export interface RoutePlan {
  modelId: string;
  modelName: string;
  capability: string;
  /** 是否指定了供应商（false = 自动路由）。 */
  pinned: boolean;
  candidates: RouteCandidate[];
}

/** 冷却中的 Key 在截止时间前不可用（与后端 key_refs 同一口径）。 */
export function keyIsCooling(key: ProviderKey, now: Date = new Date()): boolean {
  if (key.status !== 'cooling') return false;
  if (!key.cooldownUntil) return true;
  const until = Date.parse(key.cooldownUntil);
  return Number.isNaN(until) || until > now.getTime();
}

/** 目录里的模型 id 是否是内置的。 */
export function isCatalogModel(modelId: string): boolean {
  return Boolean(catalogModel(modelId));
}

/** 取绑定上的协议：绑定优先，其次目录推荐，最后旧适配器兜底。 */
export function protocolOf(
  profile: ProviderProfile,
  binding: ModelConfig,
  capability: string,
): ProtocolId {
  const explicit = binding.protocols?.[capability];
  if (explicit) return explicit;
  const recommended = catalogCapability(binding.id, capability)?.protocols?.[0];
  if (recommended) return recommended;
  return legacyProtocol(profile.adapter, capability);
}

/**
 * 生效的能力定义：目录给基线，绑定可以覆盖。
 *
 * 目录里没有这个模型时（例如用户自建的中转模型），直接用绑定自身的定义。
 */
export function effectiveCapability(
  modelId: string,
  binding: ModelConfig | undefined,
  capability: string,
): ModelCapability | undefined {
  const base = catalogCapability(modelId, capability);
  const own = binding?.capabilities.find((item) => item.capability === capability);
  if (!base) return own;
  if (!own) return base;
  return { ...base, ...own, protocols: own.protocols ?? base.protocols };
}

/** 生效的模型条目：目录给基线，绑定覆盖。 */
export function effectiveModel(
  modelId: string,
  binding: ModelConfig | undefined,
): ModelConfig | undefined {
  const base = catalogModel(modelId);
  if (!base) return binding;
  const own = binding ?? {
    id: modelId,
    displayName: modelId,
    capabilities: [],
  };
  const capabilities = [...base.capabilities];
  for (const item of own.capabilities) {
    const index = capabilities.findIndex((entry) => entry.capability === item.capability);
    if (index >= 0) capabilities[index] = { ...capabilities[index], ...item };
    else capabilities.push(item);
  }
  return {
    ...base,
    ...own,
    capabilities,
    defaults: { ...(base.defaults ?? {}), ...(own.defaults ?? {}) },
    params: own.params ?? base.params,
  };
}

/** 该模型在某供应商上的绑定条目。 */
export function bindingOf(
  profiles: ProviderProfile[],
  providerId: string,
  modelId: string,
): ModelConfig | undefined {
  return profiles
    .find((profile) => profile.id === providerId)
    ?.models.find((model) => model.id === modelId);
}

/**
 * 路由计划：某个模型在某能力下的全部候选，按优先级排序。
 *
 * providerId 为空 = 自动路由（按顺序逐家尝试）；指定 providerId = 只用这一家。
 */
export function planRoute(
  profiles: ProviderProfile[],
  modelId: string,
  capability: string,
  providerId?: string,
): RoutePlan {
  const modelName = catalogModel(modelId)?.displayName
    ?? profiles.flatMap((profile) => profile.models)
      .find((model) => model.id === modelId)?.displayName
    ?? modelId;
  const candidates: RouteCandidate[] = [];
  const pinned = Boolean(providerId);

  profiles.forEach((profile) => {
    if (!profile.enabled) return;
    if (pinned && profile.id !== providerId) return;
    const binding = profile.models.find((model) => model.id === modelId);
    if (!binding) return;
    if (binding.enabled === false) return;
    if (!effectiveCapability(modelId, binding, capability)) return;
    const keys = (profile.keys ?? [])
      .filter((key) => key.enabled !== false && key.status !== 'invalid'
        && key.hasSecret !== false && !keyIsCooling(key))
      .map((key) => ({ id: key.id, label: key.label }));
    candidates.push({
      providerId: profile.id,
      providerName: profile.name,
      modelId,
      modelName: binding.displayName || modelName,
      protocol: protocolOf(profile, binding, capability),
      priority: binding.priority ?? 100,
      keys,
      binding,
    });
  });

  candidates.sort((left, right) => left.priority - right.priority
    || left.providerId.localeCompare(right.providerId));

  return { modelId, modelName, capability, pinned, candidates };
}

/** 某个模型目前由哪些供应商提供（模型管理视图用）。 */
export function providersForModel(
  profiles: ProviderProfile[],
  modelId: string,
): Array<{ profile: ProviderProfile; binding: ModelConfig }> {
  const rows: Array<{ profile: ProviderProfile; binding: ModelConfig }> = [];
  profiles.forEach((profile) => {
    const binding = profile.models.find((model) => model.id === modelId);
    if (binding) rows.push({ profile, binding });
  });
  return rows;
}

/** 还没选模型时，可自动挑选的模型（按路由顺序）。 */
export interface AutoModel {
  modelId: string;
  modelName: string;
  providerId: string;
  providerName: string;
  priority: number;
}

export function autoModels(
  profiles: ProviderProfile[],
  capability: string,
  providerId?: string,
): AutoModel[] {
  const rows: AutoModel[] = [];
  profiles.forEach((profile) => {
    if (!profile.enabled) return;
    if (providerId && profile.id !== providerId) return;
    profile.models.forEach((binding) => {
      if (binding.enabled === false) return;
      if (!effectiveCapability(binding.id, binding, capability)) return;
      rows.push({
        modelId: binding.id,
        modelName: binding.displayName || catalogModel(binding.id)?.displayName || binding.id,
        providerId: profile.id,
        providerName: profile.name,
        priority: binding.priority ?? 100,
      });
    });
  });
  rows.sort((left, right) => left.priority - right.priority
    || left.providerId.localeCompare(right.providerId)
    || left.modelId.localeCompare(right.modelId));
  return rows;
}

/** 节点参数：通用字段 + 所选模型目录里的参数定义。 */
export function paramsForModel(modelId: string, capability: string): ParamDef[] {
  return catalogParams(modelId, capability);
}

/** 目录参数 → 节点表单字段。 */
export function fieldDefsFor(modelId: string, capability: string): FieldDef[] {
  return catalogParams(modelId, capability).map((param) => ({
    key: param.key,
    label: param.label,
    type: param.type,
    options: param.options,
    min: param.min,
    max: param.max,
    step: param.step,
    placeholder: param.placeholder,
    help: param.help,
  }));
}
