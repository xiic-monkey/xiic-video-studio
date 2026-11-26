import type { Edge, Node } from '@xyflow/react';
import type { BoardDoc, BoardNode, EdgeRole } from '../domain/types';

export interface StudioNodeData extends Record<string, unknown> {
  domain: BoardNode;
  stale: boolean;
}

const ROLE_LABEL: Record<EdgeRole, string> = {
  script: '剧本', beat: '节拍', prompt: '提示词', character_ref: '角色',
  location_ref: '场景', prop_ref: '道具', style_ref: '风格',
  first_frame: '首帧', last_frame: '尾帧', middle_frame: '中间帧',
  reference_image: '参考图', reference_video: '参考视频', reference_audio: '参考音频',
  prev_shot: '前镜', source_image: '源图', storyboard: '分镜', video_clip: '视频', audio: '音频', timeline: '时间线',
};

/**
 * 连线角色配色。
 *
 * 白底上要用中深色调，否则细线会糊在背景里看不清角色区分。
 * 这里只给 CSS 变量名，实际色值在 `src/ui/tokens.css` 里，改主题只改一处。
 */
const ROLE_COLOR: Record<EdgeRole, string> = {
  script: 'var(--edge-script)', beat: 'var(--edge-beat)', prompt: 'var(--edge-prompt)',
  character_ref: 'var(--edge-character-ref)',
  location_ref: 'var(--edge-location-ref)', prop_ref: 'var(--edge-prop-ref)', style_ref: 'var(--edge-style-ref)',
  first_frame: 'var(--edge-frame)', last_frame: 'var(--edge-frame)', middle_frame: 'var(--edge-frame)',
  reference_image: 'var(--edge-reference-image)', reference_video: 'var(--edge-reference-video)', reference_audio: 'var(--edge-reference-audio)',
  prev_shot: 'var(--edge-prev-shot)', source_image: 'var(--edge-source-image)', storyboard: 'var(--edge-storyboard)', video_clip: 'var(--edge-video-clip)', audio: 'var(--edge-audio)',
  timeline: 'var(--edge-timeline)',
};

/**
 * 节点 `data` 的身份缓存。
 *
 * `data` 里只有两样东西：领域节点本身与 stale 标记。领域节点是不可变的
 * （applyGraphCommand 改一个节点时新建对象，没改的保持原引用），
 * 所以拿节点对象当 WeakMap 键是安全的：没动过的节点复用同一个 `data`，
 * 动过的节点自然换键。
 *
 * 这是 `memo` 生效的前提——`data` 每次都新建的话，节点卡片每次都会被
 * 判成「props 变了」，改一个节点就会重渲染整板。
 */
const dataCache = new WeakMap<BoardNode, { stale: boolean; data: StudioNodeData }>();

function nodeData(node: BoardNode, stale: boolean): StudioNodeData {
  const cached = dataCache.get(node);
  if (cached && cached.stale === stale) return cached.data;
  const data: StudioNodeData = { domain: node, stale };
  dataCache.set(node, { stale, data });
  return data;
}

/**
 * 节点外壳缓存。
 *
 * React Flow 用节点对象的**身份**判断是否要重建内部节点：
 * 同一对象复用时它保留已实测的 `measured`，换新对象则把尺寸清空、
 * 退回「未测量」状态。`measured` 没了，minimap 算不出节点包围盒，
 * 于是小地图空白。
 *
 * 所以这里按节点 id 缓存外壳对象：字段没变就原地复用（身份不变），
 * 变了才换新对象。位置变化是常见的（拖拽），换新对象是正确行为——
 * React Flow 会重新测量。
 */
const shellCache = new Map<string, Node<StudioNodeData>>();

/** 外壳缓存归属的画布，换画布就整体作废。 */
let shellBoardId: string | undefined;

function shellOf(node: BoardNode, data: StudioNodeData, selected: boolean): Node<StudioNodeData> {
  const cached = shellCache.get(node.id);
  const style = node.size ? { width: node.size.width, height: node.size.height } : undefined;
  const measured = measuredCache.get(node.id);
  if (
    cached &&
    cached.type === node.type &&
    cached.data === data &&
    cached.parentId === node.parentId &&
    cached.zIndex === node.z &&
    cached.selected === selected &&
    cached.style?.width === style?.width &&
    cached.style?.height === style?.height &&
    cached.measured?.width === measured?.width &&
    cached.measured?.height === measured?.height &&
    cached.position.x === node.position.x &&
    cached.position.y === node.position.y
  ) {
    return cached;
  }
  const next: Node<StudioNodeData> = {
    id: node.id,
    type: node.type,
    position: { ...node.position },
    data,
    parentId: node.parentId,
    zIndex: node.z,
    style,
    measured: measured ? { ...measured } : undefined,
    draggable: true,
    selectable: true,
    selected,
  };
  shellCache.set(node.id, next);
  return next;
}

/**
 * 节点实测尺寸缓存。
 *
 * React Flow 用 ResizeObserver 量出节点尺寸后，只写进**内部**节点
 * （`nodeLookup`），而 MiniMap 读的却是 userNode——也就是我们传进去的
 * 那个对象。userNode 上没有 `measured`，`getNodeDimensions` 就返回 0，
 * minimap 于是判定「节点没有尺寸」而一个都不渲染，小地图全白。
 *
 * 所以这里开一个缓存：CanvasView 订阅内部 store 的实测尺寸写进来，
 * `toFlowNodes` 再把它作为 `measured` 透传给 userNode，minimap 就能算
 * 出节点包围盒。
 */
const measuredCache = new Map<string, { width: number; height: number }>();

/** measured 缓存归属的画布，换画布就整体作废。 */
let measuredBoardId: string | undefined;

/** measured 变化时的订阅者，用于让画布重建 userNode。 */
const measuredListeners = new Set<() => void>();

export function recordMeasured(id: string, width: number, height: number): void {
  const prev = measuredCache.get(id);
  if (prev && prev.width === width && prev.height === height) return;
  measuredCache.set(id, { width, height });
  for (const listener of measuredListeners) listener();
}

/** 订阅 measured 变化，返回退订函数。 */
export function subscribeMeasured(listener: () => void): () => void {
  measuredListeners.add(listener);
  return () => measuredListeners.delete(listener);
}

/** 清空全部缓存。仅供测试在用例之间隔离状态。 */
export function resetMappingCaches(): void {
  measuredCache.clear();
  shellCache.clear();
  measuredBoardId = undefined;
  shellBoardId = undefined;
}

export function toFlowNodes(doc: BoardDoc, selectedIds: string[] = [], stale?: Set<string>): Node<StudioNodeData>[] {
  const selected = new Set(selectedIds);
  const nodes = Object.values(doc.nodes);
  // 换画布就作废上一张的缓存，否则尺寸会错配到同 id 的节点上。
  if (measuredBoardId !== doc.id) {
    measuredBoardId = doc.id;
    measuredCache.clear();
  }
  if (shellBoardId !== doc.id) {
    shellBoardId = doc.id;
    shellCache.clear();
  }
  // 清掉已删除节点的缓存，避免长期使用后无限增长。
  const live = new Set(nodes.map((node) => node.id));
  for (const id of shellCache.keys()) {
    if (!live.has(id)) shellCache.delete(id);
  }
  for (const id of measuredCache.keys()) {
    if (!live.has(id)) measuredCache.delete(id);
  }
  return nodes
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((node) => shellOf(node, nodeData(node, stale?.has(node.id) ?? false), selected.has(node.id)));
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
      labelStyle: { fill: 'var(--text-muted)', fontSize: 9 },
      labelBgStyle: { fill: 'var(--panel)', fillOpacity: 0.92 },
      style: { stroke: ROLE_COLOR[edge.role], strokeWidth: 1.4 },
      data: { role: edge.role },
    }));
}

export function danglingEdgeCount(doc: BoardDoc): number {
  return Object.values(doc.edges).filter((edge) => !doc.nodes[edge.source] || !doc.nodes[edge.target]).length;
}

export function edgeColor(role: string): string {
  return ROLE_COLOR[role as EdgeRole] ?? 'var(--edge-timeline)';
}

/**
 * 节点类型色。
 *
 * 返回 CSS 变量名而不是字面色值：颜色只在 `src/ui/tokens.css` 里定义，
 * 换主题时改一处即可，画布、小地图、节点卡片自动同步。
 */
export function nodeColor(type: string): string {
  switch (type) {
    case 'script': return 'var(--node-script)';
    case 'text': return 'var(--node-text)';
    case 'audio': return 'var(--node-audio)';
    case 'image_source': return 'var(--node-source)';
    case 'video_source': return 'var(--node-source)';
    case 'audio_source': return 'var(--node-source)';
    case 'text_source': return 'var(--node-text)';
    case 'image': return 'var(--node-image)';
    case 'video': return 'var(--node-video)';
    case 'character': return 'var(--node-character)';
    case 'storyboard': return 'var(--node-storyboard)';
    case 'expression': return 'var(--node-expression)';
    case 'variant': return 'var(--node-variant)';
    case 'turnaround': return 'var(--node-turnaround)';
    case 'coverage': return 'var(--node-coverage)';
    case 'continuity': return 'var(--node-continuity)';
    case 'redraw': return 'var(--node-redraw)';
    case 'inpaint': return 'var(--node-inpaint)';
    case 'note': return 'var(--node-note)';
    case 'group': return 'var(--node-group)';
    default: return 'var(--node-note)';
  }
}
