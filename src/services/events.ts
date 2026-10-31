import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AssetRef, RunRecord } from '../domain/types';

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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
  return listen<RunUpdatedEvent>('run.updated', (event) => handler(event.payload));
}

export async function onJobUpdated(handler: (event: JobUpdatedEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<JobUpdatedEvent>('job.updated', (event) => handler(event.payload));
}

export async function onAssetCreated(handler: (asset: AssetRef) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<AssetRef>('asset.created', (event) => handler(event.payload));
}
