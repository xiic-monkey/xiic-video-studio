import { beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '../domain/types';
import { computeStaleSet } from '../domain/graph/stale';
import type { CacheContext } from '../domain/graph/cacheKey';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { topoSort } from '../domain/graph/topo';
import { validateBoard } from '../domain/graph/validate';
import { danglingEdgeCount, recordMeasured, resetMappingCaches, toFlowEdges, toFlowNodes } from './mapping';

function run(nodeId: string, id: string): RunRecord {
  return {
    id, projectId: 'project_test', boardId: 'board_test', nodeId,
    action: 'generate', cacheKey: 'stale-on-purpose', status: 'succeeded',
    promptSnapshot: { text: '', segments: [], hash: 'h', locked: false },
    params: {}, inputAssetIds: [], outputAssetIds: ['asset_1'], selectedAssetId: 'asset_1',
    startedAt: '2026-10-31T00:00:00.000Z',
  };
}

function wideBoard(count: number) {
  const nodes = Array.from({ length: count }, (_, index) => {
    const type = index % 3 === 0 ? 'text' : index % 3 === 1 ? 'image' : 'video';
    const col = Math.floor(index / 25);
    return { ...node(`n${index}`, type, { prompt: `提示 ${index}` }), position: { x: col * 320, y: (index % 25) * 220 } };
  });
  const links = nodes.slice(1).map((item, index) => edge(`e${index}`, `n${index}`, item.id));
  const doc = makeDoc(nodes, links);
  const ctx: CacheContext = {
    runs: nodes.map((item, index) => run(item.id, `run_${index}`)),
    runtime: Object.fromEntries(nodes.map((item) => [item.id, { providerId: 'openai-compatible', model: 'm', params: {} }])),
    promptHashes: Object.fromEntries(nodes.map((item) => [item.id, `hash-${item.id}`])),
  };
  return { doc, ctx };
}

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

describe('toFlowNodes 的 data 身份缓存', () => {
  beforeEach(() => resetMappingCaches());

  it('reuses the same data object for unchanged nodes', () => {
    const { doc } = wideBoard(3);
    const first = toFlowNodes(doc);
    const second = toFlowNodes(doc);
    expect(second[0].data).toBe(first[0].data);
  });

  it('only replaces the data object of nodes whose stale flag changed', () => {
    const { doc } = wideBoard(3);
    const before = toFlowNodes(doc, [], new Set());
    const after = toFlowNodes(doc, [], new Set(['n1']));
    expect(after[0].data).toBe(before[0].data);
    expect(after[1].data).not.toBe(before[1].data);
    expect(after[1].data.stale).toBe(true);
    expect(after[1].data.domain).toBe(before[1].data.domain);
  });

  it('maps a 500 node board inside the regression budget', () => {
    const { doc, ctx } = wideBoard(500);
    const started = performance.now();
    const order = topoSort(doc);
    const issues = validateBoard(doc, { providers: [] });
    const stale = computeStaleSet(doc, ctx, new Set());
    const flow = toFlowNodes(doc, [], stale);
    const elapsed = performance.now() - started;

    expect(order.order).toHaveLength(500);
    expect(flow).toHaveLength(500);
    expect(stale.size).toBe(500);
    expect(Array.isArray(issues)).toBe(true);
    // 这是「别再退化成 O(n²)」的绊线，不是性能基准；真机手感在 Step 12 手工验收。
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('toFlowNodes 的节点外壳身份缓存', () => {
  beforeEach(() => resetMappingCaches());

  it('keeps the same node object when nothing changed', () => {
    const { doc } = wideBoard(3);
    const first = toFlowNodes(doc);
    const second = toFlowNodes(doc);
    expect(second[0]).toBe(first[0]);
  });

  it('replaces the node object when its position moved', () => {
    const { doc } = wideBoard(3);
    const before = toFlowNodes(doc);
    const moved = { ...doc, nodes: { ...doc.nodes } };
    const target = Object.values(moved.nodes)[0];
    moved.nodes[target.id] = { ...target, position: { x: 999, y: 888 } };
    const after = toFlowNodes(moved);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0].position).toEqual({ x: 999, y: 888 });
  });

  it('replaces the node object when its selection state flipped', () => {
    const { doc } = wideBoard(3);
    const before = toFlowNodes(doc, []);
    const after = toFlowNodes(doc, [Object.values(doc.nodes)[0].id]);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0].selected).toBe(true);
  });
});

describe('实测尺寸透传给 userNode（minimap 依赖它算包围盒）', () => {
  beforeEach(() => resetMappingCaches());

  it('carries the measured size onto the node so the minimap can place it', () => {
    const { doc } = wideBoard(3);
    const id = Object.values(doc.nodes)[0].id;
    // 真实时序：React Flow 先量尺寸，再重建 userNode。
    toFlowNodes(doc);
    recordMeasured(id, 264, 189);
    const flow = toFlowNodes(doc);
    const target = flow.find((item) => item.id === id)!;
    expect(target.measured).toEqual({ width: 264, height: 189 });
  });

  it('refreshes the node object when the measured size changes', () => {
    const { doc } = wideBoard(3);
    const id = Object.values(doc.nodes)[0].id;
    toFlowNodes(doc);
    recordMeasured(id, 264, 189);
    const before = toFlowNodes(doc);
    recordMeasured(id, 264, 260);
    const after = toFlowNodes(doc);
    const target = after.find((item) => item.id === id)!;
    expect(target.measured).toEqual({ width: 264, height: 260 });
    expect(target).not.toBe(before.find((item) => item.id === id));
  });

  it('leaves nodes without a measured size untouched', () => {
    const { doc } = wideBoard(3);
    toFlowNodes(doc);
    const flow = toFlowNodes(doc);
    expect(flow.every((item) => item.measured === undefined)).toBe(true);
  });

  it('drops cached sizes when switching to another board', () => {
    const { doc } = wideBoard(3);
    const id = Object.values(doc.nodes)[0].id;
    toFlowNodes(doc);
    recordMeasured(id, 264, 189);
    expect(toFlowNodes(doc).find((item) => item.id === id)!.measured).toBeDefined();
    const other = { ...doc, id: 'board_other' };
    expect(toFlowNodes(other).find((item) => item.id === id)!.measured).toBeUndefined();
  });
});
