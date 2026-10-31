import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { danglingEdgeCount, toFlowEdges, toFlowNodes } from './mapping';

describe('canvas mapping', () => {
  it('maps domain nodes to React Flow nodes with parent and size', () => {
    const doc = makeDoc([
      { ...node('g', 'group'), size: { width: 400, height: 300 } },
      { ...node('t', 'text'), parentId: 'g', position: { x: 20, y: 30 }, size: { width: 260, height: 180 } },
    ], []);
    const flow = toFlowNodes(doc);
    const child = flow.find((item) => item.id === 't')!;
    expect(child.parentId).toBe('g');
    expect(child.position).toEqual({ x: 20, y: 30 });
    expect(child.style).toEqual({ width: 260, height: 180 });
    expect(child.data.domain.type).toBe('text');
  });

  it('maps edges with handles and a readable role label', () => {
    const doc = makeDoc([node('t', 'text'), node('i', 'image')], [edge('e1', 't', 'i')]);
    const [flowEdge] = toFlowEdges(doc);
    expect(flowEdge.sourceHandle).toBe('text');
    expect(flowEdge.targetHandle).toBe('prompt');
    expect(flowEdge.label).toBe('提示词');
  });

  it('hides dangling edges but counts them', () => {
    const doc = makeDoc([node('t', 'text')], [edge('e1', 't', 'missing')]);
    expect(toFlowEdges(doc)).toEqual([]);
    expect(danglingEdgeCount(doc)).toBe(1);
  });
});
