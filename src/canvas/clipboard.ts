import { newId } from '../domain/ids';
import type { BoardDoc, BoardNode } from '../domain/types';

/**
 * 画布节点剪贴板。
 *
 * 只在应用内保存，不写系统剪贴板：节点定义里带资产 id 与提示词，
 * 写到系统剪贴板会让它们出现在别的应用里。
 *
 * 剪贴板按画布隔离：换画布后粘贴不会把上一个工程的节点带过来。
 */
interface Clipboard {
  boardId: string;
  nodes: BoardNode[];
}

let current: Clipboard | undefined;

/** 复制节点。`ids` 为空时什么都不做。 */
export function copyNodes(doc: BoardDoc, ids: string[]): number {
  const nodes = ids
    .map((id) => doc.nodes[id])
    .filter((node): node is BoardNode => Boolean(node));
  if (!nodes.length) {
    current = undefined;
    return 0;
  }
  current = { boardId: doc.id, nodes };
  return nodes.length;
}

/**
 * 粘贴节点。
 *
 * 粘贴出的节点会拿到新 id 并右移，避免和原节点重叠；
 * 连线不在剪贴板范围内，粘贴后由用户重新连。
 */
export function pasteNodes(doc: BoardDoc): BoardNode[] | undefined {
  if (!current || current.boardId !== doc.id || !current.nodes.length) return undefined;
  return current.nodes.map((node, index) => ({
    ...node,
    id: newId('node'),
    position: { x: node.position.x + 40 + index * 24, y: node.position.y + 40 + index * 24 },
    parentId: undefined,
  }));
}

/** 清空剪贴板（测试与切画布时用）。 */
export function resetClipboard(): void {
  current = undefined;
}
