import { create } from 'zustand';
import { DEFAULT_PROVIDERS } from '../domain/providers/capabilities';
import { catalogModel } from '../domain/providers/catalog';
import type { ModelConfig, ProviderKey, ProviderProfile } from '../domain/types';
import {
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

/** 旧版 profile 只有一个 Key，这里补成一条可编辑的记录。 */
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
