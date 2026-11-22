import { runCapability } from '../domain/run/runtime';
import type { BoardDoc, BoardNode } from '../domain/types';

export const SHOT_ACTIONS = ['storyboard', 'firstFrame', 'lastFrame', 'video', 'dialogue'] as const;
export type ShotAction = typeof SHOT_ACTIONS[number];

export const SHOT_ACTION_LABELS: Record<ShotAction, string> = {
  storyboard: '分镜',
  firstFrame: '首帧',
  lastFrame: '尾帧',
  video: '视频',
  dialogue: '旁白',
};

/** 一个镜头动作对应的主执行节点能力。图片动作同时接受 image.edit（接了参考/风格边的图片节点）。 */
export const SHOT_ACTION_CAPABILITIES: Record<ShotAction, readonly string[]> = {
  video: ['video.generate'],
  dialogue: ['audio.tts'],
  storyboard: ['image.generate', 'image.edit'],
  firstFrame: ['image.generate', 'image.edit'],
  lastFrame: ['image.generate', 'image.edit'],
};

export const SHOT_SLOTS = ['video', 'storyboard', 'firstFrame', 'lastFrame', 'dialogue'] as const;
export type ShotSlot = typeof SHOT_SLOTS[number];

export const SHOT_SLOT_LABELS: Record<ShotSlot, string> = {
  video: '视频',
  storyboard: '分镜',
  firstFrame: '首帧',
  lastFrame: '尾帧',
  dialogue: '旁白',
};

export type AssetRefKind = 'image' | 'video' | 'audio' | 'text' | 'json';

/** 产物槽对应的素材类型。 */
export const SHOT_SLOT_ASSET_KINDS: Record<ShotSlot, readonly AssetRefKind[]> = {
  video: ['video'],
  storyboard: ['image'],
  firstFrame: ['image'],
  lastFrame: ['image'],
  dialogue: ['audio'],
};

export type ShotExecutions = Record<string, string>;

export function readShotExecutions(payload: Record<string, unknown>): ShotExecutions {
  const raw = payload.executions;
  if (!raw || typeof raw !== 'object') return {};
  const executions: ShotExecutions = {};
  for (const [action, nodeId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof nodeId === 'string' && nodeId) executions[action] = nodeId;
  }
  return executions;
}

export function withShotExecution(payload: Record<string, unknown>, action: ShotAction, nodeId: string): Record<string, unknown> {
  return { ...payload, executions: { ...readShotExecutions(payload), [action]: nodeId } };
}

export interface ShotExecutionResolution {
  nodeId?: string;
  /** 需要写回镜头 payload 的新绑定。 */
  binding?: { action: ShotAction; nodeId: string };
  /** 找不到可用节点时的中文提示。 */
  message?: string;
}

/**
 * 解析镜头动作的主执行节点：
 * 先用镜头已绑定的节点，否则挑一个还没被本镜头其它动作占用的节点。
 */
export function resolveShotExecutionNode(input: { board?: BoardDoc; executions: ShotExecutions; action: ShotAction }): ShotExecutionResolution {
  const { board, executions, action } = input;
  if (!board) return { message: '当前没有画板，请先打开画板再运行镜头动作。' };
  const capabilities = SHOT_ACTION_CAPABILITIES[action];
  const capabilityOf = (node: BoardNode) => runCapability(board, node);
  const bound = executions[action];
  if (bound) {
    const node = board.nodes[bound];
    if (node && capabilities.includes(capabilityOf(node) ?? '')) return { nodeId: node.id };
  }
  const taken = new Set(Object.entries(executions).filter(([key]) => key !== action).map(([, value]) => value));
  const free = Object.values(board.nodes).filter((node) => capabilities.includes(capabilityOf(node) ?? '') && !taken.has(node.id));
  const candidate = free.find((node) => node.type === action) ?? free[0];
  if (candidate) return { nodeId: candidate.id, binding: { action, nodeId: candidate.id } };
  return { message: `当前画板没有可用于「${SHOT_ACTION_LABELS[action]}」的独立执行节点，请先添加或绑定。` };
}
