import type { CacheContext, NodeRuntimeConfig } from '../graph/cacheKey';
import { capabilityOf } from '../providers/capabilities';
import type { Issue } from '../nodes/types';
import type {
  BoardDoc, BoardNode, ModelConfig, ProviderProfile, RunRecord, RunStatus, StyleGuide,
} from '../types';

const error = (code: string, message: string): Issue => ({ code, message, severity: 'error' });

const TERMINAL_RUN_STATUSES: RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface ResolvedModel {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  profile: ProviderProfile;
  config: ModelConfig;
}

export type ModelResolution = { ok: true; resolved: ResolvedModel } | { ok: false; issue: Issue };

export function runCapability(doc: BoardDoc, node: BoardNode): string | undefined {
  if (node.type === 'text') return 'text.chat';
  if (node.type === 'audio') return 'audio.tts';
  if (node.type === 'video') return 'video.generate';
  if (node.type === 'image') {
    const edited = Object.values(doc.edges).some((edge) =>
      edge.target === node.id && (edge.targetPort === 'references' || edge.targetPort === 'style'));
    return edited ? 'image.edit' : 'image.generate';
  }
  return undefined;
}

export function resolveModel(
  profiles: ProviderProfile[],
  hasKeys: Record<string, boolean>,
  node: BoardNode,
  capability: string,
): ModelResolution {
  const pick = (profile: ProviderProfile): ModelConfig | undefined =>
    profile.models.find((model) => capabilityOf(model, capability));

  const wrap = (profile: ProviderProfile, config: ModelConfig): ResolvedModel => ({
    providerId: profile.id,
    providerName: profile.name,
    modelId: config.id,
    modelName: config.displayName,
    profile,
    config,
  });

  const providerId = String(node.data.providerId ?? '');
  const modelId = String(node.data.model ?? '');
  if (providerId && modelId) {
    const profile = profiles.find((item) => item.id === providerId);
    const config = profile?.models.find((item) => item.id === modelId);
    if (!profile || !config || !capabilityOf(config, capability) || !profile.enabled) {
      return { ok: false, issue: error('PARAM_MODEL_INVALID', '所选模型不支持该能力，请在 Inspector 中重新选择') };
    }
    if (!hasKeys[profile.id]) {
      return { ok: false, issue: error('PROVIDER_KEY_MISSING', `${profile.name} 尚未保存 API Key`) };
    }
    return { ok: true, resolved: wrap(profile, config) };
  }

  const candidates: Array<{ profile: ProviderProfile; config: ModelConfig }> = [];
  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const config = pick(profile);
    if (config) candidates.push({ profile, config });
  }
  const usable = candidates.find((item) => hasKeys[item.profile.id]);
  if (usable) return { ok: true, resolved: wrap(usable.profile, usable.config) };
  // 明确标记为「没有 Key」（hasKeys[id] === false）的 Provider 不再算候选：
  // 此时用户已经确认过它不可用，提示「请在设置中添加模型」比提示「去保存 Key」更贴近事实。
  const pending = candidates.find((item) => hasKeys[item.profile.id] !== false);
  if (pending) {
    return { ok: false, issue: error('PROVIDER_KEY_MISSING', `${pending.profile.name} 尚未保存 API Key`) };
  }
  return { ok: false, issue: error('CAP_NO_MODEL', '没有支持该能力的模型，请先在设置中添加') };
}

export function nodeParams(node: BoardNode, capability: string): Record<string, unknown> {
  switch (capability) {
    case 'text.chat':
      return { system: String(node.data.system ?? '') };
    case 'image.generate':
    case 'image.edit':
      return {
        count: Math.min(4, Math.max(1, Math.round(Number(node.data.count ?? 1)) || 1)),
        size: String(node.data.size ?? '1024x1536'),
      };
    case 'audio.tts':
      return {
        voice: String(node.data.voice ?? 'alloy'),
        format: String(node.data.format ?? 'mp3'),
        text: String(node.data.text ?? ''),
      };
    case 'video.generate':
      return {
        mode: String(node.data.mode ?? 't2v'),
        duration: Number(node.data.duration ?? 5),
        resolution: String(node.data.resolution ?? '768P'),
        ratio: String(node.data.aspectRatio ?? '9:16'),
        generateAudio: Boolean(node.data.generateAudio ?? true),
      };
    default:
      return {};
  }
}

export interface BuildCacheContextInput {
  doc: BoardDoc;
  runs: RunRecord[];
  profiles: ProviderProfile[];
  hasKeys: Record<string, boolean>;
  styleGuide?: StyleGuide;
}

export function buildCacheContext(input: BuildCacheContextInput): CacheContext {
  const runtime: Record<string, NodeRuntimeConfig> = {};
  for (const node of Object.values(input.doc.nodes)) {
    const capability = runCapability(input.doc, node);
    if (!capability) continue;
    const resolution = resolveModel(input.profiles, input.hasKeys, node, capability);
    runtime[node.id] = {
      providerId: resolution.ok ? resolution.resolved.providerId : undefined,
      model: resolution.ok ? resolution.resolved.modelId : undefined,
      params: nodeParams(node, capability),
    };
  }
  // promptHashes 留空：computeCacheKey 会退回到节点自身的 prompt/text，
  // 上游文本内容已经通过 inputHashes（上游选中资产）进入键中。
  return { styleGuide: input.styleGuide, runs: input.runs, runtime, promptHashes: {} };
}

export function mergeRunRecord(
  runs: Record<string, RunRecord>,
  incoming: RunRecord,
): Record<string, RunRecord> | undefined {
  const previous = runs[incoming.id];
  if (previous && TERMINAL_RUN_STATUSES.includes(previous.status) && !TERMINAL_RUN_STATUSES.includes(incoming.status)) {
    return undefined;
  }
  return { ...runs, [incoming.id]: incoming };
}
