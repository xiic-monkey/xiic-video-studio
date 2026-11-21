import { latestSucceededRun, selectedAssetOf } from '../graph/cacheKey';
import type { BoardDoc, BoardNode, RunRecord } from '../types';

export const MASK_NODE_TYPE = 'inpaint';

export function isMaskNode(node: BoardNode | undefined): boolean {
  return node?.type === MASK_NODE_TYPE;
}

/** 节点上保存的蒙版资产 id（白=重绘区域）。 */
export function maskAssetIdOf(node: BoardNode): string | undefined {
  const id = node.data.maskAssetId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** 源图资产：从 source 端口连线的上游最近一次成功运行取。 */
export function sourceAssetIdOf(
  doc: BoardDoc,
  nodeId: string,
  runs: RunRecord[],
): string | undefined {
  const edge = Object.values(doc.edges).find(
    (item) => item.target === nodeId && item.targetPort === 'source',
  );
  return edge ? selectedAssetOf(latestSucceededRun(runs, edge.source)) : undefined;
}

/**
 * 蒙版画布的已涂比例（0~1）。
 *
 * 只看 alpha 通道：编辑器画的是「白笔在透明底上」，alpha>0 才是画过的像素。
 * 空蒙版提交上去模型无从下手，保存前必须拦住。
 */
export function maskPaintedRatio(pixels: Uint8ClampedArray | Uint8Array): number {
  const total = Math.floor(pixels.length / 4);
  if (!total) return 0;
  let painted = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) painted += 1;
  }
  return painted / total;
}
