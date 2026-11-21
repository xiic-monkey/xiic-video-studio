export type DataType =
  | 'text' | 'script' | 'beat' | 'character' | 'location' | 'prop'
  | 'image' | 'video' | 'audio' | 'frame' | 'timeline' | 'any';

export type EdgeRole =
  | 'script' | 'beat' | 'prompt' | 'character_ref' | 'location_ref'
  | 'prop_ref' | 'style_ref' | 'first_frame' | 'last_frame' | 'middle_frame'
  | 'reference_image' | 'reference_video' | 'reference_audio' | 'prev_shot'
  | 'source_image' | 'storyboard' | 'video_clip' | 'audio' | 'timeline';

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
  /** 路由轨迹：自动模式下依次试过哪些供应商/Key，最终用了哪家。 */
  route?: RunAttempt[];
  startedAt: string;
  finishedAt?: string;
}

export interface RunAttempt {
  providerId: string;
  providerName: string;
  keyLabel: string;
  protocol: string;
  ok: boolean;
  code?: string;
  message?: string;
  durationMs?: number;
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

/**
 * 协议 id：适配器只处理协议差异，节点与领域层不感知。
 *
 * 文本：openai-chat / openai-responses / anthropic-messages
 * 图片：openai-images / qwen-image / banana-image
 * 音频：openai-audio / minimax-tts / mimo-tts
 * 视频：minimax-video / seedance-video
 */
export type ProtocolId =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'openai-images'
  | 'qwen-image'
  | 'banana-image'
  | 'openai-audio'
  | 'minimax-tts'
  | 'mimo-tts'
  | 'minimax-video'
  | 'seedance-video';

export type ModelCapabilityId =
  | 'text.chat'
  | 'image.generate'
  | 'image.edit'
  | 'video.generate'
  | 'audio.tts';

export type ParamFieldType = 'text' | 'textarea' | 'number' | 'select' | 'toggle';

/** 模型的动态参数定义：节点表单按所选模型渲染。 */
export interface ParamDef {
  key: string;
  label: string;
  type: ParamFieldType;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  placeholder?: string;
  help?: string;
}

/** 供应商下的一个 API Key。密钥明文只在系统钥匙串，profile 里只存引用。 */
export interface ProviderKey {
  id: string;
  label: string;
  /** 钥匙串账户名：provider/{providerId}/key/{keyId} */
  keyRef: string;
  enabled: boolean;
  status: 'active' | 'cooling' | 'invalid';
  cooldownUntil?: string;
  /** 由后端注入：钥匙串里是否真的有这个密钥。 */
  hasSecret?: boolean;
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
  /** 该能力是否接受蒙版（局部重绘）。 */
  supportsMask?: boolean;
  durations?: { min: number; max: number; step: number };
  ratios?: string[];
  resolutions?: string[];
  maxPromptChars?: number;
  inputTransport: Array<'dataUrl' | 'publicUrl' | 'upload' | 'multipart'>;
  async: boolean;
  concurrency?: number;
  price?: PriceRule;
  /** 该能力支持的协议，按推荐顺序。绑定可用 protocols 覆盖其中一项。 */
  protocols?: ProtocolId[];
}

/**
 * 供应商 × 模型 = 一条绑定。
 *
 * 同一个模型可以出现在多个供应商里（同一个 modelId），
 * 同一个供应商也可以提供多个模型；priority 是该模型下的跨供应商调用顺序。
 */
export interface ModelConfig {
  id: string;
  displayName: string;
  vendor?: string;
  capabilities: ModelCapability[];
  defaults?: Record<string, unknown>;
  /** 覆盖目录里的默认协议：capability -> protocol。 */
  protocols?: Partial<Record<string, ProtocolId>>;
  /** 该模型下跨供应商的优先级，数字小的先调用。 */
  priority?: number;
  /** 针对该模型停用此供应商。 */
  enabled?: boolean;
  /** 该模型在此供应商上的参数覆盖（时长、比例、分辨率等）。 */
  params?: ParamDef[];
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
  schemaVersion: 1 | 2;
  /** 多个 Key：按顺序尝试，第一个失败（401/429）换下一个。 */
  keys?: ProviderKey[];
  /** 后端注入：这个供应商当前有没有可用密钥。 */
  hasKey?: boolean;
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

/** 内置模型目录条目：新增模型只改目录，不改代码。 */
export interface CatalogModel {
  id: string;
  displayName: string;
  vendor: string;
  capabilities: ModelCapability[];
  params?: ParamDef[];
  defaults?: Record<string, unknown>;
  /** 创建供应商时的默认值建议。 */
  suggestedProviders?: Array<{
    name: string;
    baseUrl: string;
    protocol: ProtocolId;
    authType?: 'bearer' | 'header';
  }>;
}

export function emptyStyleGuide(): StyleGuide {
  return {
    genre: '', visualStyle: '', colorLanguage: '', cameraLanguage: '',
    era: '', constraints: '', negative: '', version: 0,
  };
}
