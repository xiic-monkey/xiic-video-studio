import type { GraphCommand } from '../domain/graph/commands';
import { compilePrompt } from '../domain/prompts/compile';
import type { BoardDoc, BoardNode, PromptSnapshot, ProviderProfile, StyleGuide } from '../domain/types';

export type CandidateKind = 'image' | 'video' | 'audio' | 'text';
export type VideoMode = 't2v' | 'firstLast' | 'reference';

const PORTS_BY_MODE: Record<VideoMode, string[]> = {
  t2v: ['prompt'],
  firstLast: ['prompt', 'start', 'end'],
  reference: ['prompt', 'references', 'referenceVideo', 'referenceAudio'],
};

export function promptPreview(node: BoardNode, styleGuide?: StyleGuide): PromptSnapshot {
  const template = String(node.data.prompt ?? node.data.text ?? '');
  const lockedText = node.data.promptLocked ? String(node.data.promptOverride ?? '') : undefined;
  return compilePrompt(template, { variables: {}, styleGuide, lockedText });
}

export function pruneCommandsForMode(doc: BoardDoc, nodeId: string, mode: VideoMode): GraphCommand[] {
  const keep = new Set(PORTS_BY_MODE[mode]);
  const commands: GraphCommand[] = Object.values(doc.edges)
    .filter((edge) => edge.target === nodeId && !keep.has(edge.targetPort))
    .map((edge) => ({ type: 'disconnect' as const, edgeId: edge.id }));
  commands.push({ type: 'setNodeData', nodeId, patch: { mode } });
  return commands;
}

export function candidateKind(nodeType: string): CandidateKind {
  if (nodeType === 'video') return 'video';
  if (nodeType === 'audio') return 'audio';
  if (nodeType === 'text') return 'text';
  return 'image';
}

const CAPABILITY_LABEL: Record<string, string> = {
  'text.chat': '文本生成',
  'image.generate': '图片生成',
  'image.edit': '图片编辑',
  'video.generate': '视频生成',
  'audio.tts': '语音合成',
};

export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABEL[capability] ?? capability;
}

export { runCapability as capabilityForNode } from '../domain/run/runtime';

export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

export function modelOptions(profiles: ProviderProfile[], capability: string): ModelOption[] {
  const options: ModelOption[] = [];
  for (const profile of profiles) {
    if (!profile.enabled) continue;
    for (const model of profile.models) {
      if (!model.capabilities.some((item) => item.capability === capability)) continue;
      options.push({
        providerId: profile.id,
        providerName: profile.name,
        modelId: model.id,
        modelName: model.displayName,
      });
    }
  }
  return options;
}
