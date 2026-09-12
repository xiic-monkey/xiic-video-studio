import { invoke } from '@tauri-apps/api/core';
import type { GenerationJob, Project } from './types';

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function saveProject(project: Project) {
  if (!isTauri()) return;
  await invoke('save_project', { project });
}

export async function loadProject(projectId: string): Promise<Project | null> {
  if (!isTauri()) return null;
  return invoke<Project | null>('load_project', { projectId });
}

export async function listProjects(): Promise<Project[]> {
  if (!isTauri()) return [];
  return invoke<Project[]>('list_projects');
}

export async function loadCurrentProjectId(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>('load_current_project_id');
}

export async function saveCurrentProjectId(projectId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_current_project_id', { projectId });
}

export async function exportProjectPackage(path: string, project: Project): Promise<void> {
  if (!isTauri()) throw new Error('项目包只能在桌面应用中导出');
  await invoke('export_project_package', { path, project });
}

export async function importProjectPackage(path: string): Promise<Project> {
  if (!isTauri()) throw new Error('项目包只能在桌面应用中导入');
  return invoke<Project>('import_project_package', { path });
}

export interface DurableGenerationJob {
  id: string;
  projectId: string;
  kind: GenerationJob['kind'];
  status: GenerationJob['status'];
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export async function enqueueGenerationJob(job: DurableGenerationJob): Promise<void> {
  if (!isTauri()) return;
  await invoke('enqueue_generation_job', { job });
}

export async function listGenerationJobs(projectId: string): Promise<DurableGenerationJob[]> {
  if (!isTauri()) return [];
  return invoke<DurableGenerationJob[]>('list_generation_jobs', { projectId });
}

export async function appendGenerationTaskId(jobId: string, taskId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('append_generation_task_id', { jobId, taskId });
}

export async function updateGenerationJobStatus(jobId: string, status: GenerationJob['status']): Promise<void> {
  if (!isTauri()) return;
  await invoke('update_job_status', { jobId, status });
}

export async function saveProviderCredential(providerId: string, apiKey: string) {
  if (!isTauri()) return;
  await invoke('save_provider_credential', { providerId, apiKey });
}

export async function loadProviderCredential(providerId: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>('load_provider_credential', { providerId });
}

export interface ProviderConnectionSettings {
  providerId: string;
  baseUrl: string;
  model: string;
  textModel?: string;
  voice?: string;
}

export async function saveProviderSettings(settings: ProviderConnectionSettings): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_provider_settings', { settings });
}

export async function listProviderSettings(): Promise<ProviderConnectionSettings[]> {
  if (!isTauri()) return [];
  return invoke<ProviderConnectionSettings[]>('list_provider_settings');
}

export interface GptImageInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
  quality?: string;
  referenceImages?: string[];
}

export interface GeneratedImageResult {
  url: string;
  revisedPrompt?: string;
  provider: string;
  model: string;
}

export interface TextGenerationInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export async function generateGptImage(request: GptImageInput): Promise<GeneratedImageResult[]> {
  if (!isTauri()) return [];
  return invoke<GeneratedImageResult[]>('generate_gpt_image', { request });
}

export async function generateText(request: TextGenerationInput): Promise<string> {
  if (!isTauri()) throw new Error('请在桌面应用中配置文本模型后生成');
  return invoke<string>('generate_text', { request });
}

export interface SpeechGenerationInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  input: string;
  responseFormat?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
}

export async function generateSpeech(request: SpeechGenerationInput): Promise<string> {
  if (!isTauri()) throw new Error('语音生成只能在桌面应用中运行');
  return invoke<string>('generate_speech', { request });
}

export async function storeAudioAsset(dataUrl: string, fileName: string): Promise<string> {
  if (!isTauri()) throw new Error('音频素材只能在桌面应用中保存');
  return invoke<string>('store_audio_asset', { dataUrl, fileName });
}

export interface StoreMediaAssetInput {
  source: string;
  kind: 'image' | 'video' | 'audio';
  fileName: string;
}

export async function storeMediaAsset(request: StoreMediaAssetInput): Promise<string> {
  if (!isTauri()) throw new Error('媒体素材只能在桌面应用中保存');
  return invoke<string>('store_media_asset', { request });
}

export interface VideoGenerationInput {
  providerId: 'bytedance-video' | 'grok-video' | 'gemini-video';
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio: '16:9' | '9:16';
  duration: number;
  startFrameUrl?: string;
  endFrameUrl?: string;
  middleFrameUrl?: string;
  referenceImageUrls?: string[];
  clientRequestId?: string;
  generateAudio?: boolean;
}

export interface VideoTaskInput {
  providerId: VideoGenerationInput['providerId'];
  baseUrl: string;
  apiKey: string;
  taskId: string;
}

export interface VideoGenerationTask {
  taskId: string;
  provider: string;
  model?: string;
  status: 'queued' | 'generating' | 'polling' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  outputUrls: string[];
  rawStatus?: string;
  error?: string;
}

export async function submitVideoGeneration(request: VideoGenerationInput): Promise<VideoGenerationTask> {
  if (!isTauri()) throw new Error('请在桌面应用中配置视频模型后生成');
  return invoke<VideoGenerationTask>('submit_video_generation', { request });
}

export async function pollVideoGeneration(request: VideoTaskInput): Promise<VideoGenerationTask> {
  if (!isTauri()) throw new Error('视频任务只能在桌面应用中轮询');
  return invoke<VideoGenerationTask>('poll_video_generation', { request });
}

export async function cancelVideoGeneration(request: VideoTaskInput): Promise<void> {
  if (!isTauri()) return;
  await invoke('cancel_video_generation', { request });
}

export interface MediaQcInput {
  assetId: string;
  source: string;
  kind: 'image' | 'video';
}

export interface MediaQcResult {
  assetId: string;
  status: 'ready';
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  frameCount: number;
  contactSheetPath: string;
  warnings: string[];
  errors: string[];
}

export async function runMediaQc(request: MediaQcInput): Promise<MediaQcResult> {
  if (!isTauri()) throw new Error('媒体质检只能在桌面应用中运行');
  return invoke<MediaQcResult>('run_media_qc', { request });
}

export interface FinalCutClip {
  source: string;
  kind: 'video' | 'image';
  duration: number;
  preserveAudio?: boolean;
}

export interface FinalCutAudioTrack {
  source: string;
  start: number;
  duration: number;
  volume: number;
}

export interface FinalCutSubtitleCue {
  text: string;
  start: number;
  end: number;
}

export interface FinalCutExportInput {
  outputPath: string;
  aspectRatio: '16:9' | '9:16';
  clips: FinalCutClip[];
  transitionDuration?: number;
  coverDuration?: number;
  endCardDuration?: number;
  thumbnailSource?: string;
  contentDuration?: number;
  audioTracks?: FinalCutAudioTrack[];
  subtitles?: FinalCutSubtitleCue[];
}

export interface FinalCutExportResult {
  path: string;
  thumbnailPath?: string;
  clipCount: number;
  duration: number;
}

export async function exportFinalCut(request: FinalCutExportInput): Promise<FinalCutExportResult> {
  if (!isTauri()) throw new Error('MP4 导出只能在桌面应用中运行');
  return invoke<FinalCutExportResult>('export_final_cut', { request });
}
