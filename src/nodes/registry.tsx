import { memo } from 'react';
import type { NodeTypes } from '@xyflow/react';
import { NodeCard } from './NodeCard';

/**
 * 节点卡片用 memo 包一层。
 *
 * React Flow 每次渲染都会把节点 props 重新下发；`data` 的身份由 mapping.ts 的
 * WeakMap 缓存保证稳定，于是没变化的节点在这里被直接跳过，不进 React 渲染。
 */
const MemoNodeCard = memo(NodeCard);

export const nodeTypes: NodeTypes = {
  text: MemoNodeCard,
  image: MemoNodeCard,
  video: MemoNodeCard,
  audio: MemoNodeCard,
  script: MemoNodeCard,
  media_source: MemoNodeCard,
  character: MemoNodeCard,
  storyboard: MemoNodeCard,
  expression: MemoNodeCard,
  variant: MemoNodeCard,
  turnaround: MemoNodeCard,
  coverage: MemoNodeCard,
  continuity: MemoNodeCard,
  redraw: MemoNodeCard,
  inpaint: MemoNodeCard,
  note: MemoNodeCard,
  group: MemoNodeCard,
};
