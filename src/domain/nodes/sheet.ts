import type { BoardNode } from '../types';

/** 可以拆帧的节点类型（输出是「一张多格图」）。 */
export const SPLITTABLE_NODES = new Set([
  'character', 'storyboard', 'expression', 'turnaround', 'coverage',
]);

/** 拆帧用到的版式参数，与 Rust 侧 SheetLayout::parse 对齐。 */
export function splitLayoutFor(node: BoardNode): string | undefined {
  switch (node.type) {
    case 'character':
      return String(node.data.layout ?? 'landscape');
    case 'storyboard':
    case 'expression':
    case 'coverage':
      return String(node.data.grid ?? '3x3');
    case 'turnaround':
      return `strip:${Math.max(2, Math.min(24, Number(node.data.steps ?? 8)))}`;
    default:
      return undefined;
  }
}

export interface SheetView {
  view: string;
  label: string;
  assetId: string;
}

/** 节点上已拆出的视角。 */
export function viewsOf(node: BoardNode): SheetView[] {
  const raw = node.data.views;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is SheetView =>
    Boolean(item) && typeof (item as SheetView).assetId === 'string');
}

/** 节点级参考图。 */
export function referenceIdsOf(node: BoardNode): string[] {
  const raw = node.data.referenceAssetIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
