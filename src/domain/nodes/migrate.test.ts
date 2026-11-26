import { describe, expect, it } from 'vitest';
import { migrateBoard } from './migrate';
import type { BoardDoc, BoardEdge, BoardNode } from '../types';

function node(id: string, type: string, data: Record<string, unknown> = {}): BoardNode {
  return { id, type, typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data };
}

function edge(
  id: string,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
  role: BoardEdge['role'],
): BoardEdge {
  return { id, source, sourcePort, target, targetPort, role, createdAt: '2026-11-27T00:00:00Z' };
}

function doc(nodes: BoardNode[], edges: BoardEdge[]): BoardDoc {
  return {
    schemaVersion: 1,
    id: 'board_1',
    projectId: 'project_1',
    name: '主画布',
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    edges: Object.fromEntries(edges.map((item) => [item.id, item])),
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T00:00:00Z',
  };
}

describe('画布迁移：本地素材节点拆成三种素材节点', () => {
  it('按当时的素材类型转成对应的新节点', () => {
    const before = doc([
      node('m', 'media_source', { kind: 'video', assetId: 'a1' }),
      node('i', 'image_source', { kind: 'image', assetId: 'a2' }),
    ], []);
    const after = migrateBoard(before);
    expect(after.nodes.m.type).toBe('video_source');
    expect(after.nodes.m.data.assetId).toBe('a1');
    expect(after.nodes.i.type).toBe('image_source');
  });

  it('连线端口改名，并按两端端口重算角色', () => {
    const before = doc(
      [node('m', 'media_source', { kind: 'image', assetId: 'a1' }), node('i', 'image')],
      [edge('e1', 'm', 'output', 'i', 'references', 'reference_image')],
    );
    const after = migrateBoard(before);
    expect(after.edges.e1.sourcePort).toBe('image');
    expect(after.edges.e1.role).toBe('reference_image');
  });

  it('接首尾帧的旧连线迁移后角色是 first_frame，不是参考图', () => {
    const before = doc(
      [node('m', 'media_source', { kind: 'image', assetId: 'a1' }), node('v', 'video', { mode: 'firstLast' })],
      [edge('e1', 'm', 'output', 'v', 'start', 'reference_image')],
    );
    const after = migrateBoard(before);
    expect(after.edges.e1.sourcePort).toBe('image');
    expect(after.edges.e1.role).toBe('first_frame');
  });

  it('没有旧节点时不改动画布', () => {
    const before = doc([node('i', 'image')], []);
    expect(migrateBoard(before)).toBe(before);
  });
});
