import { create } from 'zustand';
import type { AssetRef, RunRecord } from '../domain/types';
import { mergeRunRecord } from '../domain/run/runtime';
import { listRuns } from '../services/tauri';
import { indexLatest } from '../nodes/summary';

interface RunState {
  boardId?: string;
  loading: boolean;
  error?: string;
  runs: Record<string, RunRecord>;
  latestByNode: Record<string, string>;
  assets: Record<string, AssetRef>;
  load(boardId?: string): Promise<void>;
  upsertRun(run: RunRecord): void;
  mergeAssets(assets: AssetRef[]): void;
  reset(): void;
}

export const useRunStore = create<RunState>((set, get) => ({
  loading: false,
  runs: {},
  latestByNode: {},
  assets: {},

  async load(boardId) {
    if (!boardId) {
      get().reset();
      return;
    }
    set({ boardId, loading: true, error: undefined, runs: {}, latestByNode: {}, assets: {} });
    try {
      const runs = await listRuns(boardId);
      if (get().boardId !== boardId) return;
      set({
        loading: false,
        runs: Object.fromEntries(runs.map((run) => [run.id, run])),
        latestByNode: indexLatest(runs),
      });
    } catch (error) {
      if (get().boardId !== boardId) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  upsertRun(run) {
    set((state) => {
      const runs = mergeRunRecord(state.runs, run);
      if (!runs) return state;
      return { runs, latestByNode: indexLatest(Object.values(runs)) };
    });
  },

  mergeAssets(assets) {
    set((state) => ({
      assets: { ...state.assets, ...Object.fromEntries(assets.map((asset) => [asset.id, asset])) },
    }));
  },

  reset() {
    set({ boardId: undefined, loading: false, error: undefined, runs: {}, latestByNode: {}, assets: {} });
  },
}));
