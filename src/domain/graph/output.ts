import { sha256Json } from '../hash';
import { sourceNodeKindFor } from '../nodes/definitions';
import { scriptContent } from '../nodes/scriptContent';
import type { BoardNode, RunRecord } from '../types';

/**
 * 解析节点在指定端口上产出的素材 id。
 *
 * - 悬空边（源节点已被删除）返回 undefined，调用方据此按「缺输入」处理，
 *   不能因为源节点不存在就让整块画布崩掉。
 * - 源素材节点直接给出绑定的素材 id，不需要运行记录。
 * - 其余节点取「最近一次成功运行」的选定产物：失败或仍在运行的尝试不能抹掉
 *   上一次可用结果，否则上游一次重拍就会让整条下游链路失去输入，并让下游
 *   缓存键变成 missing 而失效。
 */
export function resolveNodeOutput(node: BoardNode | undefined, portKey: string, runs: readonly RunRecord[]): string | undefined {
  if (!node) return undefined;
  // 素材节点：选好的那段素材就是它的产出，不需要跑过。
  const kind = sourceNodeKindFor(node.type);
  if (kind) {
    const assetId = node.data.assetId;
    return typeof assetId === 'string' && assetId.trim() && portKey === kind
      ? assetId
      : undefined;
  }
  // 兼容未迁移的旧画布（迁移在 loadBoard 时做，这里只是兜底）。
  if (node.type === 'media_source' || node.type === 'mediaSource') {
    const assetId = node.data.assetId;
    const kind = node.data.kind;
    const kindMatches = portKey === 'output' || portKey === 'asset' || portKey === kind || (portKey === 'frame' && kind === 'image');
    return typeof assetId === 'string' && kindMatches
      ? assetId
      : undefined;
  }
  const run = runs
    .filter((candidate) => candidate.nodeId === node.id && candidate.status === 'succeeded')
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  if (!run) return undefined;
  return run.selectedAssetId ?? run.outputAssetIds[0];
}

/**
 * 节点在指定端口上的内联文本。
 *
 * 目前有内联输出的节点：剧本节点（写着的正文/节拍就是输出内容）、
 * 文本素材节点（手写的常量文本）。它们不需要跑过就能连给下游。
 * 返回 undefined 表示这个节点没有内联输出。
 */
export function resolveInlineText(node: BoardNode | undefined, portKey: string): string | undefined {
  if (!node) return undefined;
  if (node.type === 'text_source') {
    if (portKey !== 'text') return undefined;
    const text = node.data.text;
    if (typeof text !== 'string' || !text.trim()) return undefined;
    return text;
  }
  if (node.type !== 'script') return undefined;
  const content = scriptContent(node);
  if (portKey === 'beats') return content.beats;
  if (portKey === 'script') return content.script;
  return undefined;
}

/**
 * 上游在缓存键里的指纹。
 *
 * 普通节点用产物 id：内容变了就是另一个资产。
 * 内联文本源（剧本节点）用内容哈希：正文改了，下游的缓存键必须跟着变。
 */
export function sourceFingerprint(node: BoardNode | undefined, portKey: string, runs: readonly RunRecord[]): string {
  const inline = resolveInlineText(node, portKey);
  if (inline !== undefined) return `inline:${sha256Json(inline)}`;
  return resolveNodeOutput(node, portKey, runs) ?? 'missing';
}

