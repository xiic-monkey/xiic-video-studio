import { create } from 'zustand';
import {
  inboundTextAssetIds, prepareRun, type PrepareDeps, type RunLabel, type RunRequestDraft,
} from '../domain/run/prepare';
import type { BoardDoc, CostEstimate } from '../domain/types';
import type { Issue } from '../domain/nodes/types';
import { cancelRun as cancelRemoteRun, readAssetText, startRun } from '../services/tauri';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';
import { useRunStore } from '../stores/runStore';
import { useStudioStore } from '../stores/studioStore';

export interface PendingRun {
  nodeId: string;
  request: RunRequestDraft;
  label: RunLabel;
  cost?: CostEstimate;
  warnings: Issue[];
  inputCount: number;
}

interface RunControllerState {
  busy: Record<string, boolean>;
  pending?: PendingRun;
  requestRun(nodeId: string): Promise<void>;
  confirmRun(): Promise<void>;
  dismissRun(): void;
  cancelRun(nodeId: string): Promise<void>;
}

const textCache = new Map<string, string>();

async function readTexts(assetIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(assetIds.map(async (assetId) => {
    const hit = textCache.get(assetId);
    if (hit !== undefined) {
      out[assetId] = hit;
      return;
    }
    try {
      const value = await readAssetText(assetId);
      textCache.set(assetId, value);
      out[assetId] = value;
    } catch {
      out[assetId] = '';
    }
  }));
  return out;
}

function snapshotDeps(doc: BoardDoc): PrepareDeps {
  const studio = useStudioStore.getState();
  const providers = useProviderStore.getState();
  const runs = useRunStore.getState();
  return {
    project: studio.projects.find((item) => item.id === studio.currentProjectId),
    profiles: providers.profiles,
    hasKeys: providers.hasKeys,
    runs: Object.values(runs.runs),
    assets: runs.assets,
    texts: {},
    assetHost: providers.assetHost
      ? { strategy: providers.assetHost.strategy, publicBaseUrl: providers.assetHost.publicBaseUrl }
      : undefined,
  };
}

function notify(message: string) {
  useBoardStore.getState().notify(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useRunController = create<RunControllerState>((set, get) => ({
  busy: {},

  async requestRun(nodeId) {
    const doc = useBoardStore.getState().board;
    if (!doc) return;
    set((state) => ({ busy: { ...state.busy, [nodeId]: true } }));
    try {
      const deps = snapshotDeps(doc);
      const texts = await readTexts(inboundTextAssetIds(doc, nodeId, deps.runs, deps.assets));
      const outcome = prepareRun(doc, nodeId, { ...deps, texts });
      if (!outcome.ok) {
        notify(outcome.issues.map((issue) => issue.message).join('；'));
        return;
      }
      if (outcome.cached) {
        const run = await startRun(outcome.request);
        useRunStore.getState().upsertRun(run);
        await useRunStore.getState().load(doc.id);
        notify('缓存命中，未产生费用');
        return;
      }
      set({
        pending: {
          nodeId,
          request: outcome.request,
          label: outcome.label,
          cost: outcome.cost,
          warnings: outcome.warnings,
          inputCount: outcome.request.inputs.length,
        },
      });
    } catch (error) {
      notify(messageOf(error));
    } finally {
      set((state) => ({ busy: { ...state.busy, [nodeId]: false } }));
    }
  },

  async confirmRun() {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: undefined, busy: { ...get().busy, [pending.nodeId]: true } });
    try {
      const run = await startRun(pending.request);
      useRunStore.getState().upsertRun(run);
    } catch (error) {
      notify(messageOf(error));
    } finally {
      set((state) => ({ busy: { ...state.busy, [pending.nodeId]: false } }));
    }
  },

  dismissRun() {
    set({ pending: undefined });
  },

  async cancelRun(nodeId) {
    const runs = useRunStore.getState().runs;
    const latest = Object.values(runs)
      .filter((run) => run.nodeId === nodeId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    if (!latest) return;
    if (latest.status !== 'queued' && latest.status !== 'running') {
      notify('该运行已经结束，无需取消');
      return;
    }
    try {
      await cancelRemoteRun(latest.id);
    } catch (error) {
      notify(messageOf(error));
    }
  },
}));
