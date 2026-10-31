import { sha256Json } from '../hash';
import { getNodeDefinition } from '../nodes/definitions';
import type { BoardDoc, RunRecord, StyleGuide } from '../types';

export interface NodeRuntimeConfig {
  providerId?: string;
  model?: string;
  params: Record<string, unknown>;
}

export interface CacheContext {
  styleGuide?: StyleGuide;
  runs: RunRecord[];
  runtime: Record<string, NodeRuntimeConfig>;
  promptHashes: Record<string, string>;
  referenceResolverVersion?: number;
}

const EXCLUDED_NODE_KEYS = new Set(['selectedAssetId', 'previewUrl', 'stale', 'pinned', 'draft']);

export function latestRun(runs: RunRecord[], nodeId: string): RunRecord | undefined {
  return runs
    .filter((item) => item.nodeId === nodeId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

export function latestSucceededRun(runs: RunRecord[], nodeId: string): RunRecord | undefined {
  return runs
    .filter((item) => item.nodeId === nodeId && item.status === 'succeeded')
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

export function selectedAssetOf(run: RunRecord | undefined): string | undefined {
  return run?.selectedAssetId ?? run?.outputAssetIds[0];
}

export function computeCacheKey(doc: BoardDoc, nodeId: string, ctx: CacheContext): string {
  const node = doc.nodes[nodeId];
  if (!node) return 'missing-node';
  const def = getNodeDefinition(node.type);
  const inbound = Object.values(doc.edges)
    .filter((item) => item.target === nodeId)
    .sort((left, right) => left.targetPort.localeCompare(right.targetPort) || left.id.localeCompare(right.id));
  const inputHashes = inbound.map((item) =>
    `${item.targetPort}:${selectedAssetOf(latestSucceededRun(ctx.runs, item.source)) ?? 'missing'}`);
  const nodeData = Object.fromEntries(Object.entries(node.data).filter(([key]) => !EXCLUDED_NODE_KEYS.has(key)));
  const runtime = ctx.runtime[nodeId] ?? { params: {} };
  return sha256Json({
    nodeType: node.type,
    typeVersion: def?.typeVersion ?? node.typeVersion,
    entityVersion: Number(node.data.entityVersion ?? 0),
    nodeData,
    inputHashes,
    providerId: runtime.providerId ?? '',
    model: runtime.model ?? '',
    params: runtime.params,
    promptHash: ctx.promptHashes[nodeId] ?? sha256Json(String(node.data.prompt ?? node.data.text ?? '')),
    styleGuideVersion: ctx.styleGuide?.version ?? 0,
    referenceResolverVersion: ctx.referenceResolverVersion ?? 1,
  });
}
