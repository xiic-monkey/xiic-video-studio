import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type {
  AssetRef,
  BoardDoc,
  ProviderProfile,
  RunRecord,
  StudioProject,
} from '../domain/types';

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function listStudioProjects(): Promise<StudioProject[]> {
  if (!isTauri()) return [];
  return invoke<StudioProject[]>('list_studio_projects');
}

export async function saveStudioProject(project: StudioProject): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_studio_project', { project });
}

export async function listBoards(projectId: string): Promise<BoardDoc[]> {
  if (!isTauri()) return [];
  return invoke<BoardDoc[]>('list_boards', { projectId });
}

export async function loadBoard(boardId: string): Promise<BoardDoc | null> {
  if (!isTauri()) return null;
  return invoke<BoardDoc | null>('load_board', { boardId });
}

export async function saveBoard(board: BoardDoc): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_board', { board });
}

export async function deleteBoard(boardId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('delete_board', { boardId });
}

export async function listProviderProfiles(): Promise<ProviderProfile[]> {
  if (!isTauri()) return [];
  return invoke<ProviderProfile[]>('list_provider_profiles');
}

export async function saveProviderProfile(profile: ProviderProfile): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_provider_profile', { profile });
}

/** API Key 只写入系统钥匙串，明文不会回到前端。 */
export async function setProviderKey(providerId: string, apiKey: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_provider_credential', { providerId, apiKey });
}

export async function providerHasKey(providerId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('provider_has_key', { providerId });
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  modelCount?: number;
}

export async function testProviderProfile(providerId: string): Promise<ProviderTestResult> {
  if (!isTauri()) return { ok: false, message: '请在桌面应用中测试连接' };
  return invoke<ProviderTestResult>('test_provider_profile', { providerId });
}

export interface AssetHostConfig {
  strategy: 'dataUrl' | 's3';
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  publicBaseUrl?: string;
  accessKey?: string;
  secretKey?: string;
}

export async function saveAssetHost(config: AssetHostConfig): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_asset_host', { config });
}

export async function loadAssetHost(): Promise<AssetHostConfig & { hasCredentials?: boolean }> {
  if (!isTauri()) return { strategy: 'dataUrl' };
  return invoke<AssetHostConfig & { hasCredentials?: boolean }>('load_asset_host');
}

export interface RunInput {
  role: string;
  assetId: string;
  kind: string;
  mime: string;
}

export interface StartRunInput {
  schemaVersion: 1;
  projectId: string;
  boardId: string;
  nodeId: string;
  capability: string;
  providerId: string;
  model: string;
  promptSnapshot: RunRecord['promptSnapshot'];
  params: Record<string, unknown>;
  inputs: RunInput[];
  inputAssetIds: string[];
  cacheKey: string;
  cachedAssetId?: string;
}

export async function startRun(request: StartRunInput): Promise<RunRecord> {
  if (!isTauri()) throw new Error('生成只能在桌面应用中运行');
  return invoke<RunRecord>('start_run', { request });
}

export async function cancelRun(runId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('cancel_run', { runId });
}

export async function listRuns(boardId: string): Promise<RunRecord[]> {
  if (!isTauri()) return [];
  return invoke<RunRecord[]>('list_runs', { boardId });
}

export async function selectRunCandidate(runId: string, assetId: string): Promise<RunRecord> {
  if (!isTauri()) throw new Error('选择候选只能在桌面应用中运行');
  return invoke<RunRecord>('select_run_candidate', { runId, assetId });
}

export async function resumeJobs(): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>('resume_jobs');
}

export async function assetUrl(assetId: string): Promise<string> {
  if (!isTauri()) return '';
  const path = await invoke<string>('asset_file_path', { assetId });
  return convertFileSrc(path);
}

export async function readAssetText(assetId: string): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('read_asset_text', { assetId });
}

export type { AssetRef };
