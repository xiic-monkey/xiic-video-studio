import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
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

/** 保存某个供应商下的一个 Key（多 Key 场景）。 */
export async function setProviderKeyById(
  providerId: string,
  keyId: string,
  apiKey: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_provider_key', { providerId, keyId, apiKey });
}

/** 删除某个供应商下的一个 Key。 */
export async function deleteProviderKeyById(providerId: string, keyId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('delete_provider_key', { providerId, keyId });
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
  schemaVersion: 1;
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
  if (!isTauri()) return { schemaVersion: 1, strategy: 'dataUrl' };
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

/** 资产库：按项目列出资产（不传项目则列出全部）。 */
export async function listAssets(projectId?: string): Promise<AssetRef[]> {
  if (!isTauri()) return [];
  return invoke<AssetRef[]>('list_assets', { projectId: projectId ?? null });
}

/** 拆帧：把设定图按版式切成各视角，返回每个视角的资产 id。 */
export async function splitSheet(
  assetId: string,
  layout: 'landscape' | 'portrait',
  nodeId: string,
  projectId: string,
): Promise<Array<{ view: string; label: string; assetId: string; mime: string; path: string }>> {
  if (!isTauri()) return [];
  return invoke('split_sheet', { assetId, layout, nodeId, projectId });
}

/** 保存好的蒙版资产：白=重绘区域，尺寸与源图一致。 */
export interface MaskAsset {
  assetId: string;
  mime: string;
  path: string;
  width: number;
  height: number;
}

/** 局部重绘：把画好的蒙版（PNG data URL）交给后端校验并落库。 */
export async function saveMask(
  maskDataUrl: string,
  sourceAssetId: string,
  nodeId: string,
  projectId: string,
): Promise<MaskAsset> {
  if (!isTauri()) throw new Error('保存蒙版只能在桌面应用中运行');
  return invoke('save_mask', { maskDataUrl, sourceAssetId, nodeId, projectId });
}

export async function assetUrl(assetId: string): Promise<string> {
  if (!isTauri()) return '';
  const path = await invoke<string>('asset_file_path', { assetId });
  return convertFileSrc(path);
}

/** 缩略图地址：有缩略图用缩略图，没有就退回原文件。 */
export async function assetThumbUrl(assetId: string): Promise<string> {
  if (!isTauri()) return '';
  const path = await invoke<string>('asset_thumb_file_path', { assetId });
  return convertFileSrc(path);
}

export async function readAssetText(assetId: string): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('read_asset_text', { assetId });
}

/** 旧项目导入结果：字段名与 Rust 侧 `#[serde(rename_all = "camelCase")]` 一致。 */
export interface LegacyImportResult {
  project: { id?: string; name?: string };
  board: { id?: string; name?: string };
  assetCount: number;
  runCount: number;
  warnings: string[];
}

export async function importLegacyProject(path: string): Promise<LegacyImportResult> {
  if (!isTauri()) throw new Error('旧项目导入只能在桌面应用中运行');
  return invoke<LegacyImportResult>('import_legacy_project', { path });
}

/** 导出结果：字段名与 Rust 侧 `#[serde(rename_all = "camelCase")]` 一致。 */
export interface ExportSummary {
  path: string;
  projectId: string;
  boards: number;
  runs: number;
  assets: number;
}

/**
 * 导出项目元数据包。
 *
 * 打包、路径校验与文件写入都在 Rust 侧：渲染进程只给目标路径，不能决定写到哪。
 */
export async function exportProject(projectId: string, path: string): Promise<ExportSummary> {
  if (!isTauri()) throw new Error('导出只能在桌面应用中运行');
  return invoke<ExportSummary>('export_project', { projectId, path });
}

/** 弹出保存对话框。取消时返回 null。 */
export async function pickExportPath(defaultName: string): Promise<string | null> {
  if (!isTauri()) return null;
  return save({
    defaultPath: defaultName,
    filters: [{ name: 'Frameforge 项目', extensions: ['json'] }],
  });
}

export type { AssetRef };
