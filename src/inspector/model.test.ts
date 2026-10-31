import { describe, expect, it } from 'vitest';
import { emptyStyleGuide } from '../domain/types';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { candidateKind, promptPreview, pruneCommandsForMode } from './model';

describe('inspector model', () => {
  it('compiles style variables and honors a locked override', () => {
    const style = { ...emptyStyleGuide(), visualStyle: '冷色电影感' };
    const image = node('n', 'image', { prompt: '{{style.visualStyle}}，雨夜' });
    expect(promptPreview(image, style).text).toBe('冷色电影感，雨夜');
    const locked = { ...image, data: { ...image.data, promptLocked: true, promptOverride: '锁定文本' } };
    expect(promptPreview(locked, style).text).toBe('锁定文本');
    expect(promptPreview(locked, style).locked).toBe(true);
  });

  it('prunes incompatible ports when the video mode changes', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('i', 'image'), node('v', 'video', { mode: 'reference', prompt: 'x' })],
      [
        edge('e1', 't', 'v'),
        edge('e2', 'i', 'v', 'image', 'references', 'reference_image'),
      ],
    );
    const commands = pruneCommandsForMode(doc, 'v', 'firstLast');
    expect(commands).toContainEqual({ type: 'disconnect', edgeId: 'e2' });
    expect(commands).toContainEqual({ type: 'setNodeData', nodeId: 'v', patch: { mode: 'firstLast' } });
    expect(commands.some((command) => command.type === 'disconnect' && command.edgeId === 'e1')).toBe(false);
  });

  it('maps node types to candidate kinds', () => {
    expect(candidateKind('video')).toBe('video');
    expect(candidateKind('audio')).toBe('audio');
    expect(candidateKind('text')).toBe('text');
    expect(candidateKind('image')).toBe('image');
    expect(candidateKind('note')).toBe('image');
  });
});
