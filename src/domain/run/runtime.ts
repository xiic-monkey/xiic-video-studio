import type { CacheContext, NodeRuntimeConfig } from '../graph/cacheKey';
import { capabilityOf } from '../providers/capabilities';
import { catalogParams } from '../providers/catalog';
import {
  autoModels, effectiveCapability, effectiveModel, planRoute, type RoutePlan,
} from '../providers/routing';
import type { Issue } from '../nodes/types';
import type {
  BoardDoc, BoardNode, ModelCapability, ModelConfig, ProtocolId, ProviderProfile, RunRecord,
  RunStatus, StyleGuide,
} from '../types';

const error = (code: string, message: string): Issue => ({ code, message, severity: 'error' });

const TERMINAL_RUN_STATUSES: RunStatus[] = ['succeeded', 'failed', 'cancelled'];

/** 业务化图片节点：内部仍然是 image.generate / image.edit。 */
const BUSINESS_IMAGE_NODES = new Set([
  'character', 'storyboard', 'expression', 'variant', 'turnaround', 'coverage', 'continuity', 'redraw',
]);

/** 永远走图片编辑的节点：局部重绘需要源图 + 蒙版。 */
const EDIT_ONLY_NODES = new Set(['inpaint']);

export interface ResolvedModel {
  /** 空串表示自动路由。 */
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 生效的模型定义（目录 + 绑定合并）。 */
  config: ModelConfig;
  /** 生效的能力定义。 */
  capability?: ModelCapability;
  /** 自动路由时第一个候选使用的协议。 */
  protocol: ProtocolId;
  plan: RoutePlan;
}

export type ModelResolution = { ok: true; resolved: ResolvedModel } | { ok: false; issue: Issue };

export function runCapability(doc: BoardDoc, node: BoardNode): string | undefined {
  if (node.type === 'text') return 'text.chat';
  if (node.type === 'audio') return 'audio.tts';
  if (node.type === 'video') return 'video.generate';
  if (EDIT_ONLY_NODES.has(node.type)) return 'image.edit';
  if (BUSINESS_IMAGE_NODES.has(node.type) || node.type === 'image') {
    const edited = Object.values(doc.edges).some((edge) =>
      edge.target === node.id && (edge.targetPort === 'references' || edge.targetPort === 'style'));
    return edited ? 'image.edit' : 'image.generate';
  }
  return undefined;
}

/**
 * 解析节点要用的模型。
 *
 * 节点上只记「规范模型 id」，供应商可空：
 * - 供应商为空 = 自动路由，按模型下各供应商的顺序逐家尝试；
 * - 供应商已指定 = 只用这一家。
 */
export function resolveModel(
  profiles: ProviderProfile[],
  hasKeys: Record<string, boolean>,
  node: BoardNode,
  capability: string,
): ModelResolution {
  const providerId = String(node.data.providerId ?? '').trim();
  let modelId = String(node.data.model ?? '').trim();

  if (!modelId) {
    // 节点还没选模型：按路由顺序自动挑一个（优先有 Key 的）。
    const auto = autoModels(profiles, capability, providerId || undefined);
    if (!auto.length) {
      return { ok: false, issue: error('CAP_NO_MODEL', '没有支持该能力的模型，请先在设置中添加') };
    }
    const usable = auto.find((item) => hasKeys[item.providerId]);
    modelId = (usable ?? auto[0]).modelId;
  }

  const plan = planRoute(profiles, modelId, capability, providerId || undefined);
  if (!plan.candidates.length) {
    const known = profiles.some((profile) => profile.models.some((model) => model.id === modelId));
    return {
      ok: false,
      issue: known
        ? error('PARAM_MODEL_INVALID', '所选模型没有可用于该能力的供应商，或已全部停用')
        : error('CAP_NO_MODEL', '没有支持该能力的模型，请先在设置中添加'),
    };
  }

  // 冷却中的 Key 不算可用；但老 profile 没有 Key 列表时只能退回「这家有没有 Key」。
  const usable = plan.candidates.filter((candidate) => {
    const known = profiles.find((profile) => profile.id === candidate.providerId)?.keys ?? [];
    if (known.length) return candidate.keys.length > 0;
    return hasKeys[candidate.providerId] === true;
  });
  if (!usable.length) {
    const first = plan.candidates[0];
    const known = profiles.find((profile) => profile.id === first.providerId)?.keys ?? [];
    const cooling = known.length > 0 && first.keys.length === 0;
    return {
      ok: false,
      issue: cooling
        ? error('PROVIDER_KEY_COOLING', `${first.providerName} 的所有 API Key 都在冷却中，请稍后重试`)
        : error('PROVIDER_KEY_MISSING', `${first.providerName} 尚未保存 API Key`),
    };
  }

  const primary = usable[0];
  const binding = primary.binding;
  return {
    ok: true,
    resolved: {
      providerId: plan.pinned ? primary.providerId : '',
      providerName: plan.pinned ? primary.providerName : '自动路由',
      modelId,
      modelName: primary.modelName,
      config: effectiveModel(modelId, binding) ?? {
        id: modelId,
        displayName: modelId,
        capabilities: [],
      },
      capability: effectiveCapability(modelId, binding, capability),
      protocol: primary.protocol,
      plan,
    },
  };
}

export function nodeParams(
  node: BoardNode,
  capability: string,
  model?: { id: string; capability?: ModelCapability },
): Record<string, unknown> {
  const limit = model?.capability;
  // 目录里声明并在 Inspector 渲染的参数（speed / quality 等）必须真的下发。
  // 值优先取节点数据，其次目录默认值；下面的特例逻辑再覆盖。
  const catalog: Record<string, unknown> = {};
  if (model?.id) {
    for (const param of catalogParams(model.id, capability)) {
      const value = node.data[param.key];
      if (value !== undefined && value !== null && value !== '') catalog[param.key] = value;
      else if (param.default !== undefined) catalog[param.key] = param.default;
    }
  }
  switch (capability) {
    case 'text.chat':
      return { ...catalog, system: String(node.data.system ?? '') };
    case 'image.generate':
    case 'image.edit': {
      const layout = String(node.data.layout ?? '');
      const size = node.type === 'character'
        ? (layout === 'portrait' ? '1024x1536' : '1536x1024')
        : String(node.data.size ?? '1024x1536');
      return {
        ...catalog,
        count: Math.min(4, Math.max(1, Math.round(Number(node.data.count ?? 1)) || 1)),
        size,
      };
    }
    case 'audio.tts':
      return {
        ...catalog,
        voice: String(node.data.voice ?? 'alloy'),
        format: String(node.data.format ?? 'mp3'),
        text: String(node.data.text ?? ''),
      };
    case 'video.generate': {
      const durations = limit?.durations;
      const ratios = limit?.ratios;
      const resolutions = limit?.resolutions;
      const duration = Number(node.data.duration ?? durations?.min ?? 5);
      const resolution = String(node.data.resolution ?? resolutions?.[0] ?? '768P');
      const ratio = String(node.data.aspectRatio ?? (ratios?.includes('9:16') ? '9:16' : ratios?.[0] ?? '9:16'));
      return {
        ...catalog,
        mode: String(node.data.mode ?? 't2v'),
        duration,
        resolution,
        ratio,
        generateAudio: Boolean(node.data.generateAudio ?? true),
      };
    }
    default:
      return { ...catalog };
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
      // 自动路由时供应商不进缓存键：换一家供应商不该让缓存失效。
      providerId: resolution.ok ? resolution.resolved.providerId : undefined,
      model: resolution.ok ? resolution.resolved.modelId : undefined,
      params: nodeParams(node, capability, resolution.ok ? {
        id: resolution.resolved.modelId,
        capability: resolution.resolved.capability,
      } : undefined),
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

export { capabilityOf };
