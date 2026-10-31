import { createNode } from '../nodes/definitions';
import type { BoardDoc, BoardEdge, BoardNode, EdgeRole } from '../types';

export function makeDoc(nodes: BoardNode[], edges: BoardEdge[]): BoardDoc {
  return {
    schemaVersion: 1, id: 'board_test', projectId: 'project_test', name: '测试画布',
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    edges: Object.fromEntries(edges.map((item) => [item.id, item])),
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
  };
}

export function node(id: string, type: string, data: Record<string, unknown> = {}): BoardNode {
  return { ...createNode(type, { x: 0, y: 0 }, data), id };
}

export function videoNode(id: string, data: Record<string, unknown> = {}): BoardNode {
  return node(id, 'video', { prompt: '默认提示', ...data });
}

export function edge(
  id: string, source: string, target: string,
  sourcePort = 'text', targetPort = 'prompt',
  role: EdgeRole = 'prompt',
): BoardEdge {
  return { id, source, sourcePort, target, targetPort, role, createdAt: '2026-10-31T00:00:00.000Z' };
}
