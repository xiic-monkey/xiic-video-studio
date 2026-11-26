import { edgeRoleFor, getNodeDefinition, sourceNodeKindFor } from './definitions';
import type { BoardDoc, BoardEdge, BoardNode } from '../types';

/**
 * 画布结构迁移。
 *
 * 素材节点从「一个本地素材节点（输出 any + 手填素材 ID）」拆成了
 * 图片 / 视频 / 音频三个独立节点。旧工程里已经存在的本地素材节点
 * 在加载时按它当时选的素材类型转成对应的新节点，连线的端口名与
 * 角色一并改写——用户不用手工重建，参考图也不会丢。
 */

/** 旧节点类型 → 新节点类型。 */
const LEGACY_SOURCE_TYPE: Record<string, string> = {
  media_source: 'image_source',
  mediaSource: 'image_source',
};

function legacyKind(node: BoardNode): 'image' | 'video' | 'audio' {
  const kind = String(node.data.kind ?? 'image');
  if (kind === 'video' || kind === 'audio') return kind;
  return 'image';
}

export function migrateBoard(doc: BoardDoc): BoardDoc {
  const remap = new Map<string, string>();
  const nodes: Record<string, BoardNode> = {};
  for (const [id, node] of Object.entries(doc.nodes)) {
    const target = LEGACY_SOURCE_TYPE[node.type];
    if (!target) {
      nodes[id] = node;
      continue;
    }
    const kind = legacyKind(node);
    remap.set(id, `${kind}_source`);
    nodes[id] = {
      ...node,
      type: `${kind}_source`,
      typeVersion: 1,
      data: { ...node.data, kind },
    };
  }
  if (!remap.size) return doc;

  const edges: Record<string, BoardEdge> = {};
  for (const [id, edge] of Object.entries(doc.edges)) {
    const newType = remap.get(edge.source);
    if (!newType) {
      edges[id] = edge;
      continue;
    }
    // 端口名从 output 改成素材类型本身（image / video / audio）。
    const sourcePortKey = sourceNodeKindFor(newType) ?? 'image';
    const sourceDef = getNodeDefinition(newType);
    const targetDef = getNodeDefinition(doc.nodes[edge.target]?.type ?? '');
    const sourcePort = sourceDef?.outputs.find((port) => port.key === sourcePortKey);
    const targetPort = targetDef?.inputs.find((port) => port.key === edge.targetPort);
    // 角色按两端端口重算：图片接首尾帧是 first_frame，不是 reference_image。
    const role = sourcePort && targetPort
      ? edgeRoleFor(sourcePort, targetPort)
      : edge.role;
    edges[id] = { ...edge, sourcePort: sourcePortKey, role };
  }
  return { ...doc, nodes, edges };
}
