import { create } from 'zustand';
import { DEFAULT_PROVIDERS } from '../domain/providers/capabilities';
import { catalogModel } from '../domain/providers/catalog';
import {
  isProviderConnected,
  normalizedKeys,
  profileFromCustom,
  profileFromTemplate,
  providerTemplate,
  type CustomProviderInput,
} from '../domain/providers/providerCatalog';
import type { ModelConfig, ProviderProfile } from '../domain/types';
import {
  deleteProviderProfile,
  listProviderProfiles,
  loadAssetHost,
  providerHasKey,
  saveAssetHost,
  saveProviderProfile,
  setProviderKey,
  setProviderKeyById,
  deleteProviderKeyById,
  testProviderProfile,
  type AssetHostConfig,
  type ProviderTestResult,
} from '../services/tauri';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 供应商下某个模型的绑定（同一模型可以在多个供应商里各有一条）。 */
export function bindingOf(profile: ProviderProfile, modelId: string): ModelConfig | undefined {
  return profile.models.find((model) => model.id === modelId);
}

export { isProviderConnected, normalizedKeys };

/**
 * 按目录补齐绑定里缺失的能力。
 *
 * 目录是唯一真源：目录新增能力后，老绑定里没有对应项，后端会跳过这家供应商，
 * 前端也会把它判成不支持。补齐的是「目录声明的能力」，不动用户已有的覆盖值。
 */
export function syncCatalogCapabilities(profile: ProviderProfile): {
  profile: ProviderProfile;
  changed: boolean;
} {
  let changed = false;
  const models = profile.models.map((binding) => {
    const catalog = catalogModel(binding.id);
    if (!catalog) return binding;
    const owned = new Set(binding.capabilities.map((item) => item.capability));
    const missing = catalog.capabilities.filter((item) => !owned.has(item.capability));
    if (!missing.length) return binding;
    changed = true;
    return { ...binding, capabilities: [...binding.capabilities, ...missing] };
  });
  return { profile: changed ? { ...profile, models } : profile, changed };
}

interface ProviderState {
  loaded: boolean;
  loading: boolean;
  error?: string;
  profiles: ProviderProfile[];
  hasKeys: Record<string, boolean>;
  assetHost?: AssetHostConfig & { hasCredentials?: boolean };
  settingsOpen: boolean;
  boot(): Promise<void>;
  saveProfile(profile: ProviderProfile): Promise<void>;
  /** 按供应商目录新增一家：模型按目录建议自动挂上，等填入 Key 即接入。 */
  addProvider(templateId: string): Promise<ProviderProfile | undefined>;
  /** 新增一家自定义供应商：自建网关 / 中转站 / 本地推理服务。 */
  addCustomProvider(input: CustomProviderInput): Promise<ProviderProfile | undefined>;
  /** 删掉一家供应商（连同钥匙串里的密钥）。 */
  removeProvider(profileId: string): Promise<void>;
  saveKey(providerId: string, apiKey: string): Promise<void>;
  saveKeyById(providerId: string, keyId: string, apiKey: string): Promise<void>;
  deleteKey(providerId: string, keyId: string): Promise<void>;
  /** 新增一个 Key（只改配置，密钥另行保存）。 */
  addKey(profile: ProviderProfile, label: string): ProviderProfile;
  /** 把模型加入 / 更新这家供应商的绑定。 */
  upsertBinding(profile: ProviderProfile, modelId: string, patch: Partial<ModelConfig>): ProviderProfile;
  /** 移除这家供应商提供的某个模型。 */
  removeBinding(profile: ProviderProfile, modelId: string): ProviderProfile;
  test(providerId: string): Promise<ProviderTestResult>;
  saveHost(config: AssetHostConfig): Promise<void>;
  openSettings(): void;
  closeSettings(): void;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  loaded: false,
  loading: false,
  profiles: [],
  hasKeys: {},
  settingsOpen: false,

  async boot() {
    if (get().loaded || get().loading) return;
    set({ loading: true, error: undefined });
    try {
      let profiles = await listProviderProfiles();
      if (!profiles.length) {
        for (const profile of DEFAULT_PROVIDERS) await saveProviderProfile(profile);
        profiles = await listProviderProfiles();
      }
      // 目录新增能力后，老绑定要补齐，否则后端会跳过这家供应商。
      for (const profile of profiles) {
        const synced = syncCatalogCapabilities(profile);
        if (synced.changed) {
          await saveProviderProfile(synced.profile);
          profiles = profiles.map((item) => (item.id === synced.profile.id ? synced.profile : item));
        }
      }
      const hasKeys: Record<string, boolean> = {};
      for (const profile of profiles) {
        // 后端会注入 hasKey / 每个 Key 的 hasSecret；旧的 profile 没有这些字段时回落到单独查询。
        if (typeof profile.hasKey === 'boolean') {
          hasKeys[profile.id] = profile.hasKey;
          continue;
        }
        hasKeys[profile.id] = await providerHasKey(profile.id);
      }
      const assetHost = await loadAssetHost();
      set({ loaded: true, loading: false, profiles, hasKeys, assetHost });
    } catch (error) {
      set({ loaded: true, loading: false, error: messageOf(error) });
    }
  },

  async saveProfile(profile) {
    await saveProviderProfile(profile);
    set((state) => ({
      profiles: state.profiles.some((item) => item.id === profile.id)
        ? state.profiles.map((item) => (item.id === profile.id ? profile : item))
        : [...state.profiles, profile],
      error: undefined,
    }));
  },

  async addProvider(templateId) {
    const template = providerTemplate(templateId);
    if (!template) {
      set({ error: '找不到这家供应商' });
      return undefined;
    }
    const state = get();
    const profile = profileFromTemplate(template, state.profiles.map((item) => item.id));
    await saveProviderProfile(profile);
    set((current) => ({ profiles: [...current.profiles, profile], error: undefined }));
    return profile;
  },

  async addCustomProvider(input) {
    const state = get();
    const profile = profileFromCustom(input, state.profiles.map((item) => item.id));
    await saveProviderProfile(profile);
    set((current) => ({ profiles: [...current.profiles, profile], error: undefined }));
    return profile;
  },

  async removeProvider(providerId) {
    await deleteProviderProfile(providerId);
    set((state) => {
      const hasKeys = { ...state.hasKeys };
      delete hasKeys[providerId];
      return {
        profiles: state.profiles.filter((item) => item.id !== providerId),
        hasKeys,
        error: undefined,
      };
    });
  },

  async saveKey(providerId, apiKey) {
    await setProviderKey(providerId, apiKey);
    set((state) => ({ hasKeys: { ...state.hasKeys, [providerId]: true }, error: undefined }));
  },

  async saveKeyById(providerId, keyId, apiKey) {
    await setProviderKeyById(providerId, keyId, apiKey);
    set((state) => ({ hasKeys: { ...state.hasKeys, [providerId]: true }, error: undefined }));
  },

  async deleteKey(providerId, keyId) {
    await deleteProviderKeyById(providerId, keyId);
    set((state) => {
      const profiles = state.profiles.map((profile) => {
        if (profile.id !== providerId) return profile;
        return {
          ...profile,
          keys: (profile.keys ?? []).map((key) =>
            key.id === keyId ? { ...key, hasSecret: false, status: 'active' as const } : key),
        };
      });
      return { profiles, error: undefined };
    });
  },

  addKey(profile, label) {
    const keys = normalizedKeys(profile);
    const id = `key_${keys.length + 1}_${Math.random().toString(36).slice(2, 7)}`;
    return {
      ...profile,
      schemaVersion: 2,
      keys: [...keys, {
        id,
        label: label || `Key ${keys.length + 1}`,
        keyRef: `provider/${profile.id}/key/${id}`,
        enabled: true,
        status: 'active',
        hasSecret: false,
      }],
    };
  },

  upsertBinding(profile, modelId, patch) {
    const catalog = catalogModel(modelId);
    const existing = bindingOf(profile, modelId);
    const base: ModelConfig = existing ?? {
      id: modelId,
      displayName: catalog?.displayName ?? modelId,
      vendor: catalog?.vendor,
      capabilities: catalog?.capabilities ?? [],
      defaults: catalog?.defaults,
      params: catalog?.params,
      priority: 100,
      enabled: true,
    };
    const merged: ModelConfig = { ...base, ...patch };
    // 目录声明的能力要补齐：用户手动加模型时也要拿到完整的能力集。
    if (catalog) {
      const capabilities = merged.capabilities ?? [];
      const owned = new Set(capabilities.map((item) => item.capability));
      const missing = catalog.capabilities.filter((item) => !owned.has(item.capability));
      if (missing.length) merged.capabilities = [...capabilities, ...missing];
    }
    const models = existing
      ? profile.models.map((model) => (model.id === modelId ? merged : model))
      : [...profile.models, merged];
    return { ...profile, schemaVersion: 2, models };
  },

  removeBinding(profile, modelId) {
    return {
      ...profile,
      models: profile.models.filter((model) => model.id !== modelId),
    };
  },

  async test(providerId) {
    return testProviderProfile(providerId);
  },

  async saveHost(config) {
    await saveAssetHost(config);
    const assetHost = await loadAssetHost();
    set({ assetHost, error: undefined });
  },

  openSettings() {
    set({ settingsOpen: true });
  },

  closeSettings() {
    set({ settingsOpen: false });
  },
}));
