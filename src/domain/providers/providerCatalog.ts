import type { ModelConfig, ProtocolId, ProviderKey, ProviderProfile } from '../types';
import { CATALOG, catalogModel } from './catalog';

/**
 * 供应商目录。
 *
 * 对应 OpenCode 用的 models.dev 供应商表：每个供应商有自己的 Base URL、
 * 鉴权方式和一份模型清单。这里的数据不是另写一份，而是从模型目录的
 * `suggestedProviders` 派生的——目录是唯一真源，加模型即自动多一家供应商。
 */
export interface ProviderTemplate {
  /** 目录 id：新增配置时的默认 id。 */
  id: string;
  name: string;
  baseUrl: string;
  authType: 'bearer' | 'header';
  /** 这家供应商提供的模型，以及建议协议。 */
  models: Array<{ id: string; protocol: ProtocolId }>;
}

/** 目录里已知的供应商 id。中文名没有稳定的 slug，手写一张对照表。 */
const PROVIDER_IDS: Record<string, string> = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  DeepSeek: 'deepseek',
  'Google Gemini': 'google-gemini',
  '阿里百炼': 'aliyun-bailian',
  '火山方舟': 'volcengine-ark',
  MiniMax: 'minimax',
  '小米 MiMo': 'xiaomi-mimo',
};

function templateId(name: string): string {
  const known = PROVIDER_IDS[name];
  if (known) return known;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug ? `custom-${slug}` : 'custom-provider';
}

/** 全部供应商目录条目。 */
export function providerTemplates(): ProviderTemplate[] {
  const byProvider = new Map<string, ProviderTemplate>();
  for (const model of CATALOG) {
    for (const suggestion of model.suggestedProviders ?? []) {
      const key = `${suggestion.name}|${suggestion.baseUrl}`;
      let template = byProvider.get(key);
      if (!template) {
        template = {
          id: templateId(suggestion.name),
          name: suggestion.name,
          baseUrl: suggestion.baseUrl,
          authType: suggestion.authType ?? 'bearer',
          models: [],
        };
        byProvider.set(key, template);
      }
      if (!template.models.some((item) => item.id === model.id)) {
        template.models.push({ id: model.id, protocol: suggestion.protocol });
      }
    }
  }
  // 按目录 id 排：中文名排在英文字母前面会显得乱，按 id 排出来是一张稳定的清单。
  return [...byProvider.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function providerTemplate(templateIdValue: string): ProviderTemplate | undefined {
  return providerTemplates().find((template) => template.id === templateIdValue);
}

/** 找一份已有配置对应的目录条目：先按 id，再按名称 + Base URL。 */
export function templateForProfile(profile: ProviderProfile): ProviderTemplate | undefined {
  const templates = providerTemplates();
  return templates.find((template) => template.id === profile.id)
    ?? templates.find((template) => template.name === profile.name && template.baseUrl === profile.baseUrl);
}

/** id 已被占用时加后缀，避免新增供应商覆盖已有配置。 */
export function uniqueProviderId(base: string, existingIds: string[]): string {
  if (!existingIds.includes(base)) return base;
  let index = 2;
  while (existingIds.includes(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/** 用户自定义的供应商：自建网关、中转站、本地推理服务等。 */
export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  authType: 'bearer' | 'header';
}

/** 转成只含小写字母数字和连字符的 slug；中文名会得到空串。 */
function asciiSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Base URL 的主机名：中文名没有可用 slug 时拿它顶上。 */
function hostOf(baseUrl: string): string {
  return baseUrl.trim().replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? '';
}

/**
 * 按用户填的信息生成一家自定义供应商。
 *
 * 目录里没有的供应商（自建网关、中转站、本地推理服务）走这里：
 * 用户自己给 Base URL 和鉴权方式，模型之后再往里加。
 * 协议一律按 OpenAI 兼容处理，所以测试连接走 /v1/models 那条路。
 */
export function profileFromCustom(
  input: CustomProviderInput,
  existingIds: string[],
): ProviderProfile {
  const name = input.name.trim() || '自定义供应商';
  const baseUrl = input.baseUrl.trim();
  // id 要稳定：同一个地址再添加一次也该指向同一家，别每次都随机。
  const base = asciiSlug(name) || asciiSlug(hostOf(baseUrl)) || `provider-${Math.random().toString(36).slice(2, 8)}`;
  const id = uniqueProviderId(base, existingIds);
  return {
    schemaVersion: 2,
    id,
    name,
    adapter: 'openai-compatible',
    baseUrl,
    auth: { type: input.authType, keyRef: `provider/${id}` },
    keys: [{
      id: 'default',
      label: '默认 Key',
      keyRef: `provider/${id}/key/default`,
      enabled: true,
      status: 'active',
      hasSecret: false,
    }],
    models: [],
    enabled: true,
  };
}

/** 这家是不是自定义供应商（不在内置目录里）。 */
export function isCustomProvider(profile: ProviderProfile): boolean {
  return !templateForProfile(profile);
}

/**
 * 供应商的 Key 列表。
 *
 * 旧版 profile 只有一个 Key 字段，这里补成一条记录，两种结构一套口径。
 */
export function normalizedKeys(profile: ProviderProfile): ProviderKey[] {
  if (profile.keys?.length) return profile.keys;
  return [{
    id: 'default',
    label: '默认 Key',
    keyRef: profile.auth.keyRef,
    enabled: true,
    status: 'active',
    hasSecret: profile.hasKey,
  }];
}

/**
 * 供应商是否「已接入」。
 *
 * 口径：至少有一个可用 Key（已保存密钥、没有失效、也没有被禁用）。
 * 和 OpenCode 判定 provider 是否 connected 一样：没有凭据的供应商
 * 不该出现在模型列表里，否则用户会选到一个跑不起来的模型。
 */
export function isProviderConnected(profile: ProviderProfile): boolean {
  if (!profile.enabled) return false;
  return normalizedKeys(profile).some((key) =>
    key.enabled !== false && key.status !== 'invalid' && key.hasSecret === true);
}

/** 已接入的供应商提供的模型 id 集合。 */
export function connectedModelIds(profiles: ProviderProfile[]): Set<string> {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!isProviderConnected(profile)) continue;
    for (const model of profile.models) {
      if (model.enabled === false) continue;
      ids.add(model.id);
    }
  }
  return ids;
}

/**
 * 按目录条目生成供应商配置草稿。
 *
 * 接入即绑定：选了供应商，它的模型就已经挂上（协议按目录建议），
 * 用户不必再逐个勾选——这正是 OpenCode 的做法：
 * 连上供应商，它的模型立刻可用。
 */
export function profileFromTemplate(template: ProviderTemplate, existingIds: string[]): ProviderProfile {
  const id = uniqueProviderId(template.id, existingIds);
  const profile: ProviderProfile = {
    schemaVersion: 2,
    id,
    name: template.name,
    adapter: 'openai-compatible',
    baseUrl: template.baseUrl,
    auth: { type: template.authType, keyRef: `provider/${id}` },
    keys: [{
      id: 'default',
      label: '默认 Key',
      keyRef: `provider/${id}/key/default`,
      enabled: true,
      status: 'active',
      hasSecret: false,
    }],
    models: [],
    enabled: true,
  };
  for (const item of template.models) {
    const catalog = catalogModel(item.id);
    if (!catalog) continue;
    const protocols: Record<string, ProtocolId> = {};
    for (const capability of catalog.capabilities) protocols[capability.capability] = item.protocol;
    const binding: ModelConfig = {
      id: catalog.id,
      displayName: catalog.displayName,
      vendor: catalog.vendor,
      capabilities: catalog.capabilities,
      defaults: catalog.defaults,
      params: catalog.params,
      protocols,
      priority: 100,
      enabled: true,
    };
    profile.models.push(binding);
  }
  return profile;
}
