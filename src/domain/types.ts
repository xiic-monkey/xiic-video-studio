export type DataType =
  | 'text' | 'script' | 'beat' | 'character' | 'location' | 'prop'
  | 'image' | 'video' | 'audio' | 'frame' | 'timeline' | 'any';

export type EdgeRole =
  | 'script' | 'beat' | 'prompt' | 'character_ref' | 'location_ref'
  | 'prop_ref' | 'style_ref' | 'first_frame' | 'last_frame' | 'middle_frame'
  | 'reference_image' | 'reference_video' | 'reference_audio' | 'prev_shot'
  | 'storyboard' | 'video_clip' | 'audio' | 'timeline';

export type ApprovalStatus = 'draft' | 'review' | 'approved' | 'rejected';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobStatus = 'queued' | 'submitted' | 'polling' | 'succeeded' | 'failed' | 'cancelled';

export interface BoardDoc {
  schemaVersion: 1;
  id: string;
  projectId: string;
  name: string;
  nodes: Record<string, BoardNode>;
  edges: Record<string, BoardEdge>;
  viewport: { x: number; y: number; zoom: number };
  createdAt: string;
  updatedAt: string;
}

export interface BoardNode {
  id: string;
  type: string;
  typeVersion: number;
  entityId?: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  parentId?: string;
  z: number;
  collapsed?: boolean;
  data: Record<string, unknown>;
  ui?: { color?: string; pinned?: boolean; note?: string };
}

export interface BoardEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  role: EdgeRole;
  createdAt: string;
}

export interface AssetRef {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'text' | 'json';
  path: string;
  thumbPath?: string;
  proxyPath?: string;
  mime: string;
  width?: number;
  height?: number;
  duration?: number;
  bytes: number;
  createdAt: string;
  provenance: {
    projectId: string;
    nodeId?: string;
    runId?: string;
    providerId?: string;
    model?: string;
    promptHash?: string;
    params?: Record<string, unknown>;
  };
}

export interface PromptSegment {
  key: string;
  label: string;
  text: string;
}

export interface PromptSnapshot {
  text: string;
  negative?: string;
  segments: PromptSegment[];
  hash: string;
  locked: boolean;
  missingVariables?: string[];
}

export interface CostEstimate {
  amount: number;
  currency: string;
  unit: string;
  breakdown?: Record<string, number>;
}

export interface CostBreakdown {
  estimated?: CostEstimate;
  actual?: CostEstimate;
}

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  providerRaw?: string;
  details?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  projectId: string;
  boardId: string;
  nodeId: string;
  entityId?: string;
  action: string;
  cacheKey: string;
  status: RunStatus;
  providerId?: string;
  model?: string;
  promptSnapshot: PromptSnapshot;
  params: Record<string, unknown>;
  inputAssetIds: string[];
  outputAssetIds: string[];
  selectedAssetId?: string;
  cost?: CostBreakdown;
  error?: AppError;
  startedAt: string;
  finishedAt?: string;
}

export interface JobRecord {
  id: string;
  runId: string;
  providerId: string;
  capability: string;
  remoteTaskId?: string;
  status: JobStatus;
  progress?: number;
  rawStatus?: string;
  attempts: number;
  nextPollAt?: string;
  updatedAt: string;
}

export interface StyleGuide {
  genre: string;
  visualStyle: string;
  colorLanguage: string;
  cameraLanguage: string;
  era: string;
  constraints: string;
  negative: string;
  version: number;
}

export interface PriceRule {
  unit: 'token' | 'image' | 'second' | 'character' | 'request';
  amount: number;
  currency: string;
}

export interface ModelCapability {
  capability: string;
  modes?: string[];
  maxReferenceImages?: number;
  maxReferenceVideos?: number;
  maxReferenceAudios?: number;
  freeReferenceImages?: number;
  supportsFirstFrame?: boolean;
  supportsLastFrame?: boolean;
  supportsNativeAudio?: boolean;
  durations?: { min: number; max: number; step: number };
  ratios?: string[];
  resolutions?: string[];
  maxPromptChars?: number;
  inputTransport: Array<'dataUrl' | 'publicUrl' | 'upload' | 'multipart'>;
  async: boolean;
  concurrency?: number;
  price?: PriceRule;
}

export interface ModelConfig {
  id: string;
  displayName: string;
  capabilities: ModelCapability[];
  defaults?: Record<string, unknown>;
}

export interface ProviderProfile {
  id: string;
  name: string;
  adapter: 'openai-compatible' | 'minimax-h3' | 'bytedance-video'
    | 'grok-video' | 'gemini-video' | 'comfyui' | 'custom';
  baseUrl: string;
  auth: { type: 'bearer' | 'header'; keyRef: string };
  models: ModelConfig[];
  enabled: boolean;
  schemaVersion: 1;
}

export interface StudioProject {
  schemaVersion: 1;
  id: string;
  name: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
  styleGuide: StyleGuide;
  createdAt: string;
  updatedAt: string;
}

export function emptyStyleGuide(): StyleGuide {
  return {
    genre: '', visualStyle: '', colorLanguage: '', cameraLanguage: '',
    era: '', constraints: '', negative: '', version: 0,
  };
}
