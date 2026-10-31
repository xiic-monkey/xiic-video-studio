import { describe, expect, it } from 'vitest';
import { makeDoc, node, edge } from './testFixtures';
import { applyGraphCommand } from './commands';

describe('applyGraphCommand', () => {
  it('adds a node immutably', () => {
    const doc = makeDoc([], []);
    const next = applyGraphCommand(doc, { type: 'addNode', node: node('a', 'text', { prompt: 'hi' }) });
    expect(next.nodes.a).toBeDefined();
    expect(doc.nodes.a).toBeUndefined();
    expect(next.updatedAt).not.toBe(doc.updatedAt);
  });

  it('keeps incident edges when a node is removed', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const next = applyGraphCommand(doc, { type: 'removeNode', nodeId: 'a' });
    expect(next.nodes.a).toBeUndefined();
    expect(next.edges.e1).toBeDefined();
  });

  it('promotes children when a group is removed', () => {
    const doc = makeDoc([node('a', 'note')], []);
    const grouped = applyGraphCommand(doc, { type: 'group', groupId: 'g1', childIds: ['a'], label: '组' });
    const next = applyGraphCommand(grouped, { type: 'removeNode', nodeId: 'g1' });
    expect(next.nodes.a.parentId).toBeUndefined();
    expect(next.nodes.a.position).toEqual({ x: 0, y: 0 });
  });

  it('groups and ungroups nodes while preserving absolute positions', () => {
    const doc = makeDoc([
      { ...node('a', 'note'), position: { x: 100, y: 100 } },
      { ...node('b', 'note'), position: { x: 300, y: 200 } },
    ], []);
    const grouped = applyGraphCommand(doc, { type: 'group', groupId: 'g1', childIds: ['a', 'b'], label: '镜头组' });
    expect(grouped.nodes.a.parentId).toBe('g1');
    expect(grouped.nodes.a.position).toEqual({ x: 24, y: 64 });
    expect(grouped.nodes.g1.position).toEqual({ x: 76, y: 36 });
    const ungrouped = applyGraphCommand(grouped, { type: 'ungroup', groupId: 'g1' });
    expect(ungrouped.nodes.a.position).toEqual({ x: 100, y: 100 });
    expect(ungrouped.nodes.a.parentId).toBeUndefined();
    expect(ungrouped.nodes.g1).toBeUndefined();
  });

  it('patches node data and ui without replacing the node', () => {
    const doc = makeDoc([node('a', 'image', { prompt: 'old' })], []);
    const next = applyGraphCommand(doc, { type: 'setNodeData', nodeId: 'a', patch: { prompt: 'new' } });
    expect(next.nodes.a.data.prompt).toBe('new');
    expect(next.nodes.a.id).toBe('a');
  });
});
