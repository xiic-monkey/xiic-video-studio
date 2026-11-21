import { computeCacheKey, latestSucceededRun, selectedAssetOf } from '../graph/cacheKey';
import { getNodeDefinition } from '../nodes/definitions';
import { isMaskNode, maskAssetIdOf } from '../nodes/mask';
import { instructionFor } from '../nodes/templates';
import type { Issue, NodeContext } from '../nodes/types';
import { capabilityOf, estimateCost } from '../providers/capabilities';
import { compilePrompt } from '../prompts/compile';
import { validateBoard } from '../graph/validate';
import { buildCacheContext, nodeParams, resolveModel, runCapability } from './runtime';
import type {
  AssetRef, BoardDoc, BoardEdge, CostEstimate, DataType, ModelCapability, PromptSnapshot,
  ProviderProfile, RunRecord, StudioProject,
} from '../types';

const error = (code: string, message: string): Issue => ({ code, message, severity: 'error' });

const MODE_LABEL: Record<string, string> = {
  t2v: '文生视频', firstLast: '首尾帧', reference: '全能参考',
};

export interface RunRequestDraft {
  schemaVersion: 1;
  projectId: string;
  boardId: string;
  nodeId: string;
  capability: string;
  providerId: string;
  model: string;
  /** 前端按目录解析出的协议；后端候选优先采用它。 */
  protocol: string;
  promptSnapshot: PromptSnapshot;
  params: Record<string, unknown>;
  inputs: Array<{ role: string; assetId: string; kind: string; mime: string }>;
  inputAssetIds: string[];
  cacheKey: string;
  cachedAssetId?: string;
  /** 节点级参考图（拆帧出来的视角）。 */
  referenceAssetIds?: string[];
}

export interface RunLabel {
  nodeTitle: string;
  capability: string;
  providerName: string;
  modelName: string;
}

export interface PrepareDeps {
  project?: StudioProject;
  profiles: ProviderProfile[];
  hasKeys: Record<string, boolean>;
  runs: RunRecord[];
  assets: Record<string, AssetRef>;
  texts: Record<string, string>;
  assetHost?: { strategy?: string; publicBaseUrl?: string };
}

export type PrepareOutcome =
  | { ok: true; request: RunRequestDraft; cost?: CostEstimate; cached: boolean; label: RunLabel; warnings: Issue[] }
  | { ok: false; issues: Issue[] };

interface Inbound {
  edge: BoardEdge;
  assetId: string;
  kind: AssetRef['kind'];
  mime: string;
}

function kindForPort(dataType?: DataType): AssetRef['kind'] {
  if (dataType === 'image' || dataType === 'frame') return 'image';
  if (dataType === 'video') return 'video';
  if (dataType === 'audio') return 'audio';
  return 'text';
}

function inboundAssets(doc: BoardDoc, nodeId: string, runs: RunRecord[], assets: Record<string, AssetRef>): Inbound[] {
  const def = getNodeDefinition(doc.nodes[nodeId]?.type ?? '');
  const items: Inbound[] = [];
  for (const edge of Object.values(doc.edges)) {
    if (edge.target !== nodeId) continue;
    const assetId = selectedAssetOf(latestSucceededRun(runs, edge.source));
    if (!assetId) continue;
    const stored = assets[assetId];
    const port = def?.inputs.find((item) => item.key === edge.targetPort);
    items.push({ edge, assetId, kind: stored?.kind ?? kindForPort(port?.dataType), mime: stored?.mime ?? '' });
  }
  return items;
}

export function inboundTextAssetIds(
  doc: BoardDoc,
  nodeId: string,
  runs: RunRecord[],
  assets: Record<string, AssetRef>,
): string[] {
  const ids = inboundAssets(doc, nodeId, runs, assets)
    .filter((item) => item.kind === 'text' || item.kind === 'json')
    .map((item) => item.assetId);
  return [...new Set(ids)];
}

function referenceOverflow(inputs: RunRequestDraft['inputs'], limit?: ModelCapability): string | undefined {
  const rules: Array<[string, number, string]> = [
    ['reference_image', limit?.maxReferenceImages ?? Number.POSITIVE_INFINITY, '参考图'],
    ['reference_video', limit?.maxReferenceVideos ?? Number.POSITIVE_INFINITY, '参考视频'],
    ['reference_audio', limit?.maxReferenceAudios ?? Number.POSITIVE_INFINITY, '参考音频'],
    ['first_frame', limit && limit.supportsFirstFrame === false ? 0 : Number.POSITIVE_INFINITY, '首帧'],
    ['last_frame', limit && limit.supportsLastFrame === false ? 0 : Number.POSITIVE_INFINITY, '尾帧'],
  ];
  for (const [role, max, label] of rules) {
    const count = inputs.filter((item) => item.role === role).length;
    if (count === 0 || count <= max) continue;
    return max === 0 ? `${label}不受支持` : `${label}超出模型上限（最多 ${max}）`;
  }
  return undefined;
}

export function prepareRun(doc: BoardDoc, nodeId: string, deps: PrepareDeps): PrepareOutcome {
  const node = doc.nodes[nodeId];
  if (!node) return { ok: false, issues: [error('GRAPH_UNKNOWN_NODE', '节点不存在，无法运行')] };

  const def = getNodeDefinition(node.type);
  if (!def || !def.actions.length) {
    return { ok: false, issues: [error('RUN_NOT_RUNNABLE', `${def?.title ?? node.type} 节点没有可执行动作`)] };
  }
  const capability = runCapability(doc, node);
  if (!capability) return { ok: false, issues: [error('RUN_NOT_RUNNABLE', '该节点没有可执行能力')] };

  const ctx: NodeContext = { providers: deps.profiles, styleGuide: deps.project?.styleGuide };
  const blocking = validateBoard(doc, ctx).filter(
    (issue) => issue.nodeId === nodeId && issue.severity === 'error',
  );
  if (blocking.length) return { ok: false, issues: blocking };

  const model = resolveModel(deps.profiles, deps.hasKeys, node, capability);
  if (!model.ok) return { ok: false, issues: [model.issue] };
  const { resolved } = model;
  const limit = resolved.capability ?? capabilityOf(resolved.config, capability);

  const issues: Issue[] = [];
  const items = inboundAssets(doc, nodeId, deps.runs, deps.assets);
  const variables: Record<string, string> = {};
  const mediaInputs: RunRequestDraft['inputs'] = [];

  for (const item of items) {
    if (item.kind === 'text' || item.kind === 'json') {
      const value = (deps.texts[item.assetId] ?? '').trim();
      if (!value) {
        // 上游文本读取失败或为空：花钱前拦住，并且不把这条变量写进 prompt。
        const sourceTitle = getNodeDefinition(doc.nodes[item.edge.source]?.type ?? '')?.title ?? item.edge.source;
        issues.push(error('RUN_UPSTREAM_TEXT_EMPTY', `上游「${sourceTitle}」的文本读取失败或为空，请先重新运行该上游节点`));
        continue;
      }
      const key = item.edge.targetPort;
      variables[key] = variables[key] ? `${variables[key]}\n\n${value}` : value;
      if (key === 'prompt') variables.text = variables.prompt;
      continue;
    }
    mediaInputs.push({ role: item.edge.role, assetId: item.assetId, kind: item.kind, mime: item.mime });
  }

  // 局部重绘：蒙版是节点级资产，不混进连线输入；模型必须支持蒙版。
  const maskAssetId = isMaskNode(node) ? maskAssetIdOf(node) : undefined;
  if (isMaskNode(node)) {
    if (!maskAssetId) issues.push(error('RUN_MASK_MISSING', '请先在 Inspector 绘制并保存蒙版'));
    if (limit && !limit.supportsMask) {
      issues.push(error('CAP_MASK_UNSUPPORTED', `${resolved.modelName} 不支持蒙版局部重绘`));
    }
    if (maskAssetId) {
      mediaInputs.push({ role: 'mask', assetId: maskAssetId, kind: 'image', mime: 'image/png' });
    }
  }

  for (const edge of Object.values(doc.edges)) {
    if (edge.target !== nodeId) continue;
    if (!selectedAssetOf(latestSucceededRun(deps.runs, edge.source))) {
      const sourceTitle = getNodeDefinition(doc.nodes[edge.source]?.type ?? '')?.title ?? edge.source;
      issues.push({
        code: 'RUN_UPSTREAM_MISSING',
        message: `上游「${sourceTitle}」还没有可用结果，请先运行该上游节点`,
        severity: 'error',
      });
    }
  }

  const template0 = String(node.data.prompt ?? node.data.text ?? '');
  const appendable = Object.keys(variables).filter(
    (key) => key !== 'system' && !(key === 'text' && variables.prompt),
  );
  const unreferenced = appendable.filter((key) => !template0.includes(`{{${key}}}`));
  let template = template0;
  if (unreferenced.length) {
    const suffix = unreferenced.map((key) => `{{${key}}}`).join('\n');
    template = template0.trim() ? `${template0}\n\n${suffix}` : suffix;
  }

  const instruction = instructionFor(node);
  const finalTemplate = instruction ? `${template}\n\n${instruction}` : template;

  const snapshot = compilePrompt(finalTemplate, {
    variables,
    styleGuide: deps.project?.styleGuide,
    negative: String(node.data.negative ?? ''),
    lockedText: node.data.promptLocked ? String(node.data.promptOverride ?? '') : undefined,
  });

  if (snapshot.missingVariables?.length) {
    issues.push(error('PROMPT_MISSING_VARIABLE', `提示词变量没有来源：${snapshot.missingVariables.join('、')}`));
  }
  const finalText = snapshot.text.trim();
  if (!finalText) issues.push(error('PARAM_PROMPT_EMPTY', '提示词为空，请填写或连接上游文本节点'));
  const chars = [...finalText].length;
  if (limit?.maxPromptChars && chars > limit.maxPromptChars) {
    issues.push(error('PARAM_PROMPT_TOO_LONG', `提示词 ${chars} 字符，超过模型上限 ${limit.maxPromptChars}`));
  }

  const params = nodeParams(node, capability, {
    id: resolved.modelId,
    capability: resolved.capability,
  });
  // 节点里写的系统提示在前，上游带来的系统提示在后（不再整段覆盖本地的）。
  const localSystem = String(params.system ?? '').trim();
  const upstreamSystem = String(variables.system ?? '').trim();
  if (localSystem && upstreamSystem) params.system = `${localSystem}\n\n${upstreamSystem}`;
  else if (upstreamSystem) params.system = upstreamSystem;
  if (capability === 'audio.tts') params.text = finalText;

  if (capability === 'video.generate') {
    const mode = String(params.mode ?? 't2v');
    if (limit?.modes && !limit.modes.includes(mode)) {
      issues.push(error('PARAM_MODE_UNSUPPORTED', `${resolved.modelName} 不支持${MODE_LABEL[mode] ?? mode}模式`));
    }
    const duration = Number(params.duration ?? 0);
    const range = limit?.durations;
    if (range && (!Number.isInteger(duration) || duration < range.min || duration > range.max)) {
      issues.push(error('PARAM_DURATION_RANGE', `时长需在 ${range.min}–${range.max} 秒之间`));
    }
    const resolution = String(params.resolution ?? '');
    if (limit?.resolutions && !limit.resolutions.includes(resolution)) {
      issues.push(error('PARAM_RESOLUTION_UNSUPPORTED', `${resolved.modelName} 不支持 ${resolution || '空'} 分辨率`));
    }
    const ratio = String(params.ratio ?? '');
    if (limit?.ratios && !limit.ratios.includes(ratio)) {
      issues.push(error('PARAM_RATIO_UNSUPPORTED', `${resolved.modelName} 不支持 ${ratio || '空'} 比例`));
    }
  }

  // 节点级参考图也要算进模型的上限。
  const referenceAssetIds = Array.isArray(node.data.referenceAssetIds)
    ? node.data.referenceAssetIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const overflow = referenceOverflow(
    [
      ...mediaInputs,
      ...referenceAssetIds.map((assetId) => ({ role: 'reference_image', assetId, kind: 'image', mime: '' })),
    ],
    limit,
  );
  if (overflow) issues.push(error('PARAM_REFERENCE_LIMIT', overflow));

  // 节点级参考图也要走同样的传输方式：只看 mediaInputs 会漏掉「仅用拆帧参考图」的情况。
  const needsPublicUrl = (mediaInputs.length + referenceAssetIds.length) > 0 && limit
    && limit.inputTransport.includes('publicUrl')
    && !limit.inputTransport.includes('dataUrl');
  if (needsPublicUrl && !(deps.assetHost?.strategy === 's3' && deps.assetHost.publicBaseUrl)) {
    issues.push(error('CAP_PUBLIC_URL_REQUIRED', '该模型只接受公网素材链接，请在「设置 → 素材外链」配置 S3 兼容桶'));
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length) return { ok: false, issues: errors };

  const cacheCtx = buildCacheContext({
    doc,
    runs: deps.runs,
    profiles: deps.profiles,
    hasKeys: deps.hasKeys,
    styleGuide: deps.project?.styleGuide,
  });
  const cacheKey = computeCacheKey(doc, nodeId, cacheCtx);
  const reusable = deps.runs
    .filter((run) => run.nodeId === nodeId && run.status === 'succeeded' && run.cacheKey === cacheKey && selectedAssetOf(run))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const cachedAssetId = selectedAssetOf(reusable);

  const request: RunRequestDraft = {
    schemaVersion: 1,
    projectId: doc.projectId,
    boardId: doc.id,
    nodeId,
    capability,
    providerId: resolved.providerId,
    model: resolved.modelId,
    protocol: resolved.protocol,
    promptSnapshot: snapshot,
    params,
    inputs: mediaInputs,
    inputAssetIds: items.map((item) => item.assetId),
    cacheKey,
    cachedAssetId,
    referenceAssetIds,
  };

  return {
    ok: true,
    request,
    cost: estimateCost(resolved.config, capability, params),
    cached: Boolean(cachedAssetId),
    label: {
      nodeTitle: def.title,
      capability,
      providerName: resolved.providerName,
      modelName: resolved.modelName,
    },
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}
