import type { GraphCommand } from '../domain/graph/commands';
import { compilePrompt } from '../domain/prompts/compile';
import type { BoardDoc, BoardNode, PromptSnapshot, StyleGuide } from '../domain/types';

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
