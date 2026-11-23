import { invoke } from '@tauri-apps/api/core';
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

export async function saveBoard(board: BoardDoc): Promise<{ revision?: number }> {
  if (!isTauri()) return {};
  return invoke<{ revision?: number }>('save_board', { board, expectedRevision: board.revision ?? null });
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
  entityId?: string;
  action?: string;
  capability: string;
  providerId: string;
  model: string;
  /** 前端按目录解析出的协议；绑定里显式配的协议优先于它。 */
  protocol?: string;
  promptSnapshot: RunRecord['promptSnapshot'];
  params: Record<string, unknown>;
  inputs: RunInput[];
  inputAssetIds: string[];
  cacheKey: string;
  cachedAssetId?: string;
  /** 节点级参考图（拆帧出来的视角），由后端按资产 id 解析。 */
  referenceAssetIds?: string[];
}

// 后端不再暴露 start_run：所有付费运行都必须先走 prepare_paid_run 预览、
// 再用 start_paid_run 单次提交，避免绕过费用确认。

export interface RunPreview {
  previewId: string;
  fingerprint: string;
  projectId: string;
  boardId: string;
  cached: boolean;
  routes: string[];
  estimates: Record<string, unknown>;
  warnings: string[];
  expiresAt: string;
}

export async function preparePaidRun(projectId: string, boardId: string, expectedRevision: number, draft: StartRunInput): Promise<RunPreview> {
  if (!isTauri()) throw new Error('付费运行预览只能在桌面应用中创建');
  return invoke<RunPreview>('prepare_paid_run', { projectId, boardId, expectedRevision, draft });
}

export async function startPaidRun(preview: RunPreview, request: StartRunInput): Promise<RunRecord> {
  if (!isTauri()) throw new Error('付费运行只能在桌面应用中确认');
  return invoke<RunRecord>('start_paid_run', { previewId: preview.previewId, fingerprint: preview.fingerprint, request });
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

export interface ProjectAssetPage {
  items: AssetRef[];
  nextCursor?: string;
}

export interface MediaTask {
  id: string;
  projectId: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'paused';
  assetId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export async function importMedia(projectId: string): Promise<MediaTask | undefined> {
  if (!isTauri()) throw new Error('本地媒体导入仅支持桌面应用');
  const grants = await invoke<Array<{ id: string; displayName: string }>>('pick_media_files', { projectId });
  if (!grants.length) return undefined;
  return invoke<MediaTask>('import_media', { projectId, fileGrantIds: grants.map((grant) => grant.id), requestId: crypto.randomUUID() });
}

export async function listMediaTasks(projectId: string): Promise<MediaTask[]> {
  if (!isTauri()) return [];
  return invoke<MediaTask[]>('list_media_tasks', { projectId });
}

export async function cancelMediaTask(projectId: string, jobId: string): Promise<MediaTask> {
  if (!isTauri()) throw new Error('取消媒体任务仅支持桌面应用');
  return invoke<MediaTask>('cancel_media_task', { projectId, jobId });
}

export async function applyProductionChange(projectId: string, changeId: string, expectedRevisions: Record<string, number>, operations: unknown[]): Promise<{ changeId: string; revisionMap: Record<string, number>; affectedIds: string[] }> {
  if (!isTauri()) throw new Error('制作变更只能在桌面应用中保存');
  return invoke('apply_production_change', { projectId, changeId, expectedRevisions, operations });
}

export async function saveBreakdownDraft(projectId: string, draftId: string, scriptId: string, scriptRevision: number, payload: unknown): Promise<void> {
  if (!isTauri()) throw new Error('拆镜草案只能在桌面应用中保存');
  await invoke('save_breakdown_draft', { projectId, draftId, scriptId, scriptRevision, payload });
}

export async function listBreakdownDrafts(projectId: string, scriptId: string): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invoke<unknown[]>('list_breakdown_drafts', { projectId, scriptId });
}

export async function adoptShotMedia(projectId: string, changeId: string, expectedRevisions: Record<string, number>, shotId: string, slot: string, assetId: string, specHash: string): Promise<{ changeId: string; revisionMap: Record<string, number>; affectedIds: string[] }> {
  if (!isTauri()) throw new Error('镜头采纳仅支持桌面应用');
  return invoke('adopt_shot_media', { projectId, changeId, expectedRevisions, shotId, slot, assetId, specHash });
}

export async function recordProductionReview(projectId: string, changeId: string, expectedRevisions: Record<string, number>, entityId: string, review: Record<string, unknown>): Promise<{ changeId: string; revisionMap: Record<string, number>; affectedIds: string[] }> {
  if (!isTauri()) throw new Error('制作审批仅支持桌面应用');
  return invoke('record_production_review', { projectId, changeId, expectedRevisions, entityId, review });
}

export interface ProductionEntity {
  id: string;
  projectId?: string;
  kind: string;
  revision: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
  updatedAt: string;
}

export async function createLocalComposeEntity(
  projectId: string,
  boardId: string,
  timeline: Record<string, unknown>,
): Promise<{ changeId: string; revisionMap: Record<string, number>; affectedIds: string[] }> {
  const id = typeof timeline.id === 'string' ? timeline.id : `${projectId}:${boardId}:compose`;
  return applyProductionChange(projectId, crypto.randomUUID(), { [id]: 0 }, [{ id, kind: 'timeline', payload: timeline }]);
}

export async function commitTimelineEdit(
  projectId: string,
  timelineId: string,
  expectedRevision: number,
  timeline: Record<string, unknown>,
): Promise<{ changeId: string; revisionMap: Record<string, number>; affectedIds: string[] }> {
  return applyProductionChange(projectId, crypto.randomUUID(), { [timelineId]: expectedRevision }, [{ id: timelineId, kind: 'timeline', payload: timeline }]);
}

export async function replaceTimelineClip(
  projectId: string,
  timelineId: string,
  expectedRevision: number,
  clipId: string,
  assetId: string,
  sourceInTicks: number,
  sourceOutTicks: number,
  acknowledgeShorter: boolean,
): Promise<{ changeId: string; revisionMap: Record<string, number>; affectedIds: string[] }> {
  if (!isTauri()) throw new Error('时间线换片仅支持桌面应用');
  return invoke('replace_timeline_clip', {
    projectId,
    changeId: crypto.randomUUID(),
    expectedRevisions: { [timelineId]: expectedRevision },
    timelineId,
    payload: { clipId, assetId, sourceInTicks, sourceOutTicks, acknowledgeShorter },
  });
}

export async function listProductionEntityPage(projectId: string, kind?: string): Promise<ProductionEntity[]> {
  if (!isTauri()) return [];
  return invoke<ProductionEntity[]>('list_production_entities', { projectId, kind: kind ?? null });
}

export async function pickSubtitleFile(projectId: string): Promise<{ id: string; displayName: string } | undefined> {
  if (!isTauri()) return undefined;
  const grant = await invoke<{ id: string; displayName: string } | null>('pick_subtitle_file', { projectId });
  return grant ?? undefined;
}

export async function importSubtitleDocument(projectId: string, fileGrantId: string): Promise<{ text: string; displayName: string }> {
  if (!isTauri()) throw new Error('字幕导入仅支持桌面应用');
  return invoke('import_subtitle_document', { projectId, fileGrantId });
}

export async function pickScriptFile(projectId: string): Promise<{ id: string; displayName: string } | undefined> {
  if (!isTauri()) return undefined;
  const grant = await invoke<{ id: string; displayName: string } | null>('pick_script_file', { projectId });
  return grant ?? undefined;
}

export async function importScriptDocument(projectId: string, fileGrantId: string): Promise<{ title: string; body: string; displayName: string }> {
  if (!isTauri()) throw new Error('剧本导入仅支持桌面应用');
  return invoke('import_script_document', { projectId, fileGrantId });
}

export interface MediaExportPreview {
  previewId: string;
  projectId: string;
  timelineId: string;
  editHash: string;
  totalTicks: number;
  preset: string;
  /** 阻断级问题：必须修好，不允许靠确认放行。 */
  issues: string[];
  /** 必须明确确认级问题：逐条确认后可继续交付。 */
  warnings: string[];
}

export async function prepareMediaExport(projectId: string, timelineId: string, expectedRevision: number, preset = 'vertical-1080x1920'): Promise<MediaExportPreview> {
  if (!isTauri()) throw new Error('导出仅支持桌面应用');
  return invoke('prepare_media_export', { projectId, timelineId, expectedRevision, preset });
}

export async function startMediaExport(previewId: string, acknowledgedIssueIds: string[], requestId: string, targetGrantId: string): Promise<MediaTask> {
  if (!isTauri()) throw new Error('导出仅支持桌面应用');
  return invoke('start_media_export', { previewId, acknowledgedIssueIds, requestId, targetGrantId });
}

export async function pickExportTarget(projectId: string): Promise<{ id: string; displayName: string } | undefined> {
  if (!isTauri()) throw new Error('导出仅支持桌面应用');
  const grant = await invoke<{ id: string; displayName: string } | null>('pick_export_target', { projectId });
  return grant ?? undefined;
}


/** 资产库：项目 ID 是授权边界，缺少项目时不读取任何素材。 */
export async function listAssets(projectId?: string): Promise<AssetRef[]> {
  if (!isTauri() || !projectId) return [];
  const page = await invoke<ProjectAssetPage>('list_project_assets', { projectId, kind: null, query: null, cursor: null });
  return page.items;
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

export async function assetUrl(projectId: string, assetId: string): Promise<string> {
  if (!isTauri() || !projectId) return '';
  const grant = await invoke<{ url: string }>('open_project_media', { projectId, assetId, rendition: 'original' });
  return grant.url;
}

/** 缩略图地址：有缩略图用缩略图，没有就退回原文件。 */
export async function assetThumbUrl(projectId: string, assetId: string): Promise<string> {
  if (!isTauri() || !projectId) return '';
  const grant = await invoke<{ url: string }>('open_project_media', { projectId, assetId, rendition: 'thumbnail' });
  return grant.url;
}

export async function readAssetText(projectId: string, assetId: string): Promise<string> {
  if (!isTauri() || !projectId) return '';
  const value = await invoke<string | undefined>('read_project_asset_text', { projectId, assetId });
  if (value === undefined) throw new Error('资产文本读取失败');
  return value;
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
