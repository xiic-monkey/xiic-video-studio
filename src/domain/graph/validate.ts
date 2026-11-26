import { edgeRoleFor, getNodeDefinition, visibleInputPorts } from '../nodes/definitions';
import type { Issue, NodeContext } from '../nodes/types';
import type { BoardDoc, BoardEdge, BoardNode, DataType } from '../types';
import { topoSort } from './topo';

/**
 * 数据类型的兼容族。
 *
 * - 文本族：普通文本、剧本、节拍都是「一段可以直接塞进提示词的文字」，
 *   剧本节点的正文/节拍必须能连给任何文本输入端口。
 * - 图像族：image 与 frame 等价（frame 只是「当作首尾帧用的图」）。
 */
const IMAGE_LIKE = new Set<DataType>(['image', 'frame']);
const TEXT_LIKE = new Set<DataType>(['text', 'script', 'beat']);

export function compatibleTypes(source: DataType, target: DataType): boolean {
  if (source === 'any' || target === 'any' || source === target) return true;
  if (IMAGE_LIKE.has(source) && IMAGE_LIKE.has(target)) return true;
  return TEXT_LIKE.has(source) && TEXT_LIKE.has(target);
}

/**
 * 源端口的真实数据类型。
 *
 * 旧的本地素材节点输出端口声明为 any（素材种类是节点上的一个可改字段），
 * 连线校验时按节点当前选的素材类型判定，避免把视频素材连到「参考图」
 * 这种必然失败的连线上。新的图片 / 视频 / 音频素材节点端口类型是固定的，
 * 走不到这个分支；这里留着只为兼容尚未迁移的旧画布。
 */
export function effectiveSourceType(node: BoardNode, portKey: string, declared: DataType): DataType {
  if (declared !== 'any') return declared;
  if (node.type !== 'media_source' || portKey !== 'output') return declared;
  const kind = String(node.data.kind ?? '');
  if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
  return declared;
}

const KIND_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频' };

export function validateBoard(doc: BoardDoc, ctx: NodeContext): Issue[] {
  const issues: Issue[] = [];
  for (const node of Object.values(doc.nodes)) {
    const def = getNodeDefinition(node.type);
    if (!def) {
      issues.push({ code: 'GRAPH_UNKNOWN_NODE', message: `未知节点类型 ${node.type}`, severity: 'error', nodeId: node.id });
      continue;
    }
    issues.push(...def.validate(node, ctx));
  }

  for (const item of Object.values(doc.edges)) {
    issues.push(...validateEdge(doc, item));
  }

  for (const node of Object.values(doc.nodes)) {
    issues.push(...validateRequiredInputs(doc, node));
    issues.push(...validateVideoMode(doc, node));
  }

  const { cycle } = topoSort(doc);
  if (cycle.length) {
    issues.push({ code: 'GRAPH_CYCLE', message: '画布存在环，P0 只允许 DAG', severity: 'error', nodeId: cycle[0] });
  }
  return issues;
}

function validateEdge(doc: BoardDoc, item: BoardEdge): Issue[] {
  const issues: Issue[] = [];
  const source = doc.nodes[item.source];
  const target = doc.nodes[item.target];
  if (!source || !target) {
    issues.push({ code: 'GRAPH_BROKEN_EDGE', message: '连线的一端已被删除，请重新连接', severity: 'warning' });
    return issues;
  }
  const sourceDef = getNodeDefinition(source.type);
  const targetDef = getNodeDefinition(target.type);
  const sourcePort = sourceDef?.outputs.find((port) => port.key === item.sourcePort);
  const targetPort = targetDef?.inputs.find((port) => port.key === item.targetPort);
  if (!sourcePort || !targetPort) {
    issues.push({ code: 'GRAPH_UNKNOWN_PORT', message: '连线端口不存在', severity: 'error', nodeId: target.id });
    return issues;
  }
  if (targetDef && !visibleInputPorts(targetDef, target).some((port) => port.key === item.targetPort)) {
    issues.push({ code: 'GRAPH_PORT_HIDDEN', message: '当前节点模式不接受这个端口，请切换模式或改用其他端口', severity: 'error', nodeId: target.id, portKey: item.targetPort });
    return issues;
  }
  const sourceType = effectiveSourceType(source, item.sourcePort, sourcePort.dataType);
  if (!compatibleTypes(sourceType, targetPort.dataType)) {
    const sourceLabel = sourceType === sourcePort.dataType
      ? sourcePort.label
      : `${sourcePort.label}（${KIND_LABEL[sourceType] ?? sourceType}）`;
    issues.push({ code: 'GRAPH_TYPE_MISMATCH', message: `${sourceLabel} 不能连接到 ${targetPort.label}`, severity: 'error', nodeId: target.id, portKey: targetPort.key });
  }
  if (targetPort.role && item.role !== targetPort.role) {
    issues.push({ code: 'GRAPH_ROLE_MISMATCH', message: `连线角色应为 ${targetPort.role}`, severity: 'error', nodeId: target.id, portKey: targetPort.key });
  }
  if (!targetPort.multi) {
    const others = Object.values(doc.edges).filter((other) =>
      other.target === item.target && other.targetPort === item.targetPort && other.id !== item.id);
    if (others.length) {
      issues.push({ code: 'GRAPH_SINGLE_INPUT', message: `${targetPort.label} 只能连接一个来源`, severity: 'error', nodeId: target.id, portKey: targetPort.key });
    }
  }
  return issues;
}

function validateRequiredInputs(doc: BoardDoc, node: BoardNode): Issue[] {
  const def = getNodeDefinition(node.type);
  if (!def) return [];
  const inbound = Object.values(doc.edges).filter((item) => item.target === node.id);
  const issues: Issue[] = [];
  for (const port of visibleInputPorts(def, node)) {
    if (port.required && !inbound.some((item) => item.targetPort === port.key)) {
      issues.push({ code: 'GRAPH_REQUIRED_INPUT', message: `${port.label} 未连接`, severity: 'error', nodeId: node.id, portKey: port.key });
    }
  }
  return issues;
}

function validateVideoMode(doc: BoardDoc, node: BoardNode): Issue[] {
  if (node.type !== 'video') return [];
  const inbound = Object.values(doc.edges).filter((item) => item.target === node.id);
  const hasFrame = inbound.some((item) => item.targetPort === 'start' || item.targetPort === 'end');
  const hasReference = inbound.some((item) => ['references', 'referenceVideo', 'referenceAudio'].includes(item.targetPort));
  const mode = String(node.data.mode ?? 't2v');
  const issues: Issue[] = [];
  if (mode === 'firstLast' && hasReference) {
    issues.push({ code: 'VIDEO_MODE_CONFLICT', message: '首尾帧模式与全能参考模式互斥，请断开参考连线或切换模式', severity: 'error', nodeId: node.id });
  }
  if (mode === 'reference' && hasFrame) {
    issues.push({ code: 'VIDEO_MODE_CONFLICT', message: '全能参考模式不能使用首/尾帧端口', severity: 'error', nodeId: node.id });
  }
  if (mode === 't2v' && (hasFrame || hasReference)) {
    issues.push({ code: 'VIDEO_MODE_CONFLICT', message: '文生视频模式不接受首尾帧或参考素材', severity: 'error', nodeId: node.id });
  }
  if (mode === 'firstLast' && !hasFrame) {
    issues.push({ code: 'PARAM_FRAME_REQUIRED', message: '首尾帧模式至少需要首帧或尾帧', severity: 'error', nodeId: node.id });
  }
  if (mode === 'reference' && !hasReference) {
    issues.push({ code: 'PARAM_REFERENCE_REQUIRED', message: '全能参考模式至少需要一张参考素材', severity: 'error', nodeId: node.id });
  }
  return issues;
}

export function nodeIssues(doc: BoardDoc, nodeId: string, ctx: NodeContext): Issue[] {
  return validateBoard(doc, ctx).filter((issue) => issue.nodeId === nodeId);
}

export function validateConnection(
  doc: BoardDoc,
  sourceId: string,
  sourcePortKey: string,
  targetId: string,
  targetPortKey: string,
): Issue[] {
  const source = doc.nodes[sourceId];
  const target = doc.nodes[targetId];
  if (!source || !target) {
    return [{ code: 'GRAPH_BROKEN_EDGE', message: '连线的一端不存在', severity: 'error' }];
  }
  const sourceDef = getNodeDefinition(source.type);
  const targetDef = getNodeDefinition(target.type);
  const sourcePort = sourceDef?.outputs.find((port) => port.key === sourcePortKey);
  const targetPort = targetDef?.inputs.find((port) => port.key === targetPortKey);
  if (!sourcePort || !targetPort) {
    return [{ code: 'GRAPH_UNKNOWN_PORT', message: '端口不存在', severity: 'error', nodeId: targetId, portKey: targetPortKey }];
  }
  const probe: BoardEdge = {
    id: '__probe__', source: sourceId, sourcePort: sourcePortKey,
    target: targetId, targetPort: targetPortKey,
    role: edgeRoleFor(sourcePort, targetPort), createdAt: 'probe',
  };
  return validateEdge(doc, probe);
}
