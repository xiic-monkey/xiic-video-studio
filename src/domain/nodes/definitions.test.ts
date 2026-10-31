import { describe, expect, it } from 'vitest';
import { createNode, edgeRoleFor, getNodeDefinition, listNodeDefinitions, visibleInputPorts } from './definitions';

describe('node definitions', () => {
  it('registers the seven P0 primitive nodes', () => {
    expect(listNodeDefinitions().map((def) => def.type).sort())
      .toEqual(['audio', 'group', 'image', 'note', 'script', 'text', 'video']);
  });

  it('creates a video node with H3-safe defaults', () => {
    const node = createNode('video', { x: 10, y: 20 });
    expect(node.id).toMatch(/^node_/);
    expect(node.typeVersion).toBe(1);
    expect(node.data).toMatchObject({ mode: 't2v', duration: 6, resolution: '768P', aspectRatio: '9:16' });
  });

  it('hides frame ports in reference mode and hides reference ports in firstLast mode', () => {
    const def = getNodeDefinition('video')!;
    const base = createNode('video', { x: 0, y: 0 });
    const firstLast = visibleInputPorts(def, { ...base, data: { ...base.data, mode: 'firstLast' } });
    const reference = visibleInputPorts(def, { ...base, data: { ...base.data, mode: 'reference' } });
    expect(firstLast.map((port) => port.key)).toEqual(['prompt', 'start', 'end']);
    expect(reference.map((port) => port.key)).toEqual(['prompt', 'references', 'referenceVideo', 'referenceAudio']);
  });

  it('derives edge roles from the target port first', () => {
    const def = getNodeDefinition('video')!;
    const start = def.inputs.find((port) => port.key === 'start')!;
    const prompt = def.inputs.find((port) => port.key === 'prompt')!;
    const imageOut = getNodeDefinition('image')!.outputs[0];
    const textOut = getNodeDefinition('text')!.outputs[0];
    expect(edgeRoleFor(imageOut, start)).toBe('first_frame');
    expect(edgeRoleFor(textOut, prompt)).toBe('prompt');
  });
});
