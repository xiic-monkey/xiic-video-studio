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

