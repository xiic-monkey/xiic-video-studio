import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AssetRef, RunRecord } from '../domain/types';

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * 包一层解绑函数。
 *
 * 事件插件侧的监听表在热更新后可能被重置，此时解绑会抛
 * 「listeners[eventId] is undefined」。解绑失败不影响功能，
 * 不该变成一条未处理的异步错误弹到界面上。
 */
function guarded(unlisten: UnlistenFn): UnlistenFn {
  return () => {
    try {
      void Promise.resolve(unlisten()).catch(() => undefined);
    } catch {
      // 解绑失败：忽略即可。
    }
  };
}

export interface RunUpdatedEvent {
  run: RunRecord;
  assets: AssetRef[];
}

export interface JobUpdatedEvent {
  id: string;
  status: string;
  progress?: number;
  rawStatus?: string;
  attempts?: number;
}

export async function onRunUpdated(handler: (event: RunUpdatedEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return guarded(await listen<RunUpdatedEvent>('run/updated', (event) => handler(event.payload)));
}

export async function onJobUpdated(handler: (event: JobUpdatedEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return guarded(await listen<JobUpdatedEvent>('job/updated', (event) => handler(event.payload)));
}

export async function onAssetCreated(handler: (asset: AssetRef) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return guarded(await listen<AssetRef>('asset/created', (event) => handler(event.payload)));
}
