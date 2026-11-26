import { create } from 'zustand';
import type { AssetRef } from '../domain/types';
import { listAssets } from '../services/tauri';

interface AssetState {
  assets: AssetRef[];
  /** 当前素材列表所属的项目：切项目后旧素材要清掉，不能混着显示。 */
  projectId?: string;
  loading: boolean;
  /** 加载指定项目的素材；项目为空时清空列表。 */
  load(projectId?: string): Promise<void>;
  /** 重新拉取当前项目的素材：导入、删除之后调用。 */
  refresh(): Promise<void>;
  /** 素材已从库里移除时本地同步，避免整表重载。 */
  remove(assetId: string): void;
}

/**
 * 素材列表。
 *
 * 之前素材只在资产库组件内部加载，左栏看不到数量、也没法和抽屉共享同一份数据。
 * 抽成 store 后，左栏入口的计数、抽屉里的网格、Inspector 里的参考图选择器
 * 都读同一份数据，切项目时统一失效。
 */
export const useAssetStore = create<AssetState>((set, get) => ({
  assets: [],
  loading: false,

  async load(projectId) {
    if (!projectId) {
      set({ assets: [], projectId: undefined, loading: false });
      return;
    }
    // 立刻换项目并清空列表：上一个项目的素材不能在新项目里多留一帧。
    set({ assets: [], projectId, loading: true });
    try {
      const assets = await listAssets(projectId);
      // 请求期间可能又切了项目：过期的结果直接丢掉。
      if (get().projectId !== projectId) return;
      set({ assets, loading: false });
    } catch {
      if (get().projectId !== projectId) return;
      set({ assets: [], loading: false });
    }
  },

  async refresh() {
    const projectId = get().projectId;
    if (!projectId) return;
    const assets = await listAssets(projectId);
    if (get().projectId !== projectId) return;
    set({ assets });
  },

  remove(assetId) {
    set((state) => ({ assets: state.assets.filter((item) => item.id !== assetId) }));
  },
}));
