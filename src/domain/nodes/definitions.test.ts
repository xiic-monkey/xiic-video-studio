import { describe, expect, it } from 'vitest';
import { createNode, edgeRoleFor, getNodeDefinition, listNodeDefinitions, visibleInputPorts } from './definitions';

describe('node definitions', () => {
  it('registers the primitive nodes plus the business ones', () => {
    expect(listNodeDefinitions().map((def) => def.type).sort())
      .toEqual([
        'audio', 'character', 'continuity', 'coverage', 'expression', 'group', 'image', 'inpaint', 'note',
        'redraw', 'script', 'storyboard', 'text', 'turnaround', 'variant', 'video',
      ]);
  });

  it('gives the character sheet node a layout and background choice', () => {
    const node = createNode('character', { x: 0, y: 0 });
    expect(node.data).toMatchObject({ layout: 'landscape', background: 'white' });
    const def = getNodeDefinition('character')!;
    expect(def.actions[0].capability).toBe('image.generate');
    expect(def.inputs.map((port) => port.key)).toEqual(['prompt', 'references']);
  });

  it('defines the inpaint node as an edit-only node with a required source port', () => {
    const def = getNodeDefinition('inpaint')!;
    expect(def.actions[0].capability).toBe('image.edit');
    expect(def.inputs.map((port) => port.key)).toEqual(['prompt', 'source']);
    expect(def.inputs[1].required).toBe(true);
    expect(def.inputs[1].role).toBe('source_image');
    expect(createNode('inpaint', { x: 0, y: 0 }).data).toMatchObject({ maskAssetId: '' });
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
