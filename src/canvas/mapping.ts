import type { Edge, Node } from '@xyflow/react';
import type { BoardDoc, BoardNode, EdgeRole } from '../domain/types';

export interface StudioNodeData extends Record<string, unknown> {
  domain: BoardNode;
}

const ROLE_LABEL: Record<EdgeRole, string> = {
  script: '剧本', beat: '节拍', prompt: '提示词', character_ref: '角色',
  location_ref: '场景', prop_ref: '道具', style_ref: '风格',
  first_frame: '首帧', last_frame: '尾帧', middle_frame: '中间帧',
  reference_image: '参考图', reference_video: '参考视频', reference_audio: '参考音频',
  prev_shot: '前镜', storyboard: '分镜', video_clip: '视频', audio: '音频', timeline: '时间线',
};

const ROLE_COLOR: Record<EdgeRole, string> = {
  script: '#d8b66a', beat: '#c9a85f', prompt: '#8d9a98', character_ref: '#75d8bd',
  location_ref: '#7fa8d8', prop_ref: '#a98fd0', style_ref: '#d8b66a',
  first_frame: '#b08ad8', last_frame: '#8f6fba', middle_frame: '#9b7fc2',
  reference_image: '#b08ad8', reference_video: '#b08ad8', reference_audio: '#62c8b4',
  prev_shot: '#bf7256', storyboard: '#bf7256', video_clip: '#bf7256', audio: '#62c8b4',
  timeline: '#e4ecea',
};

export function toFlowNodes(doc: BoardDoc, selectedIds: string[] = []): Node<StudioNodeData>[] {
  const selected = new Set(selectedIds);
  return Object.values(doc.nodes)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: { domain: node },
      parentId: node.parentId,
      zIndex: node.z,
      style: node.size ? { width: node.size.width, height: node.size.height } : undefined,
      draggable: true,
      selectable: true,
      selected: selected.has(node.id),
    }));
}

export function toFlowEdges(doc: BoardDoc): Edge[] {
  return Object.values(doc.edges)
    .filter((edge) => doc.nodes[edge.source] && doc.nodes[edge.target])
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
      label: ROLE_LABEL[edge.role],
      labelStyle: { fill: '#9aa9a7', fontSize: 9 },
      labelBgStyle: { fill: '#151b1c', fillOpacity: 0.9 },
      style: { stroke: ROLE_COLOR[edge.role], strokeWidth: 1.4 },
      data: { role: edge.role },
    }));
}

export function danglingEdgeCount(doc: BoardDoc): number {
  return Object.values(doc.edges).filter((edge) => !doc.nodes[edge.source] || !doc.nodes[edge.target]).length;
}

export function edgeColor(role: string): string {
  return ROLE_COLOR[role as EdgeRole] ?? '#5c6a68';
}

export function nodeColor(type: string): string {
  if (type === 'script') return '#d8b66a';
  if (type === 'text') return '#d8b66a';
  if (type === 'audio') return '#62c8b4';
  if (type === 'image' || type === 'video') return '#b08ad8';
  if (type === 'group') return '#52605e';
  return '#7f908e';
}
