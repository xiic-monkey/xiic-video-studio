import { create } from 'zustand';
import { DEFAULT_PROVIDERS } from '../domain/providers/capabilities';
import type { ProviderProfile } from '../domain/types';
import {
  listProviderProfiles,
  loadAssetHost,
  providerHasKey,
  saveAssetHost,
  saveProviderProfile,
  setProviderKey,
  testProviderProfile,
  type AssetHostConfig,
  type ProviderTestResult,
} from '../services/tauri';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      const hasKeys = Object.fromEntries(await Promise.all(
        profiles.map(async (profile) => [profile.id, await providerHasKey(profile.id)] as const),
      ));
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
