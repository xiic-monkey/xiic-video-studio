import { describe, expect, it } from 'vitest';
import type { BoardDoc, BoardNode } from '../domain/types';
import { readShotExecutions, resolveShotExecutionNode, SHOT_SLOT_ASSET_KINDS, withShotExecution } from './shotExecution';

function node(id: string, type: string): BoardNode {
  return { id, type, typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data: {} };
}

function board(nodes: BoardNode[]): BoardDoc {
  return {
    schemaVersion: 1,
    id: 'board',
    projectId: 'p',
    name: 'board',
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    edges: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: '',
    updatedAt: '',
  };
}

describe('shot execution nodes', () => {
  it('gives each shot action its own node instead of one shared node', () => {
    const doc = board([node('img_1', 'image'), node('img_2', 'image'), node('vid_1', 'video')]);
    const storyboard = resolveShotExecutionNode({ board: doc, executions: {}, action: 'storyboard' });
    const firstFrame = resolveShotExecutionNode({ board: doc, executions: { storyboard: storyboard.nodeId! }, action: 'firstFrame' });
    expect(storyboard.nodeId).toBe('img_1');
    expect(firstFrame.nodeId).toBe('img_2');
  });

  it('reuses the node already bound to the same action', () => {
    const doc = board([node('img_1', 'image'), node('img_2', 'image')]);
    const resolution = resolveShotExecutionNode({ board: doc, executions: { storyboard: 'img_2' }, action: 'storyboard' });
    expect(resolution.nodeId).toBe('img_2');
    expect(resolution.binding).toBeUndefined();
  });

  it('refuses to reuse a node that another action already owns', () => {
    const doc = board([node('img_1', 'image')]);
    const resolution = resolveShotExecutionNode({ board: doc, executions: { storyboard: 'img_1' }, action: 'lastFrame' });
    expect(resolution.nodeId).toBeUndefined();
    expect(resolution.message).toContain('独立执行节点');
  });

  it('accepts an image node whose capability is image.edit', () => {
    const doc = board([node('img_1', 'image')]);
    doc.edges = { e1: { id: 'e1', source: 'img_2', target: 'img_1', sourcePort: 'output', targetPort: 'references', role: 'reference_image', createdAt: '' } };
    const resolution = resolveShotExecutionNode({ board: doc, executions: {}, action: 'storyboard' });
    expect(resolution.nodeId).toBe('img_1');
  });

  it('prefers a node whose type matches the action', () => {
    const doc = board([node('img_1', 'image'), node('grid_1', 'storyboard')]);
    expect(resolveShotExecutionNode({ board: doc, executions: {}, action: 'storyboard' }).nodeId).toBe('grid_1');
  });

  it('maps video and dialogue to their own capabilities', () => {
    const doc = board([node('vid_1', 'video'), node('voice_1', 'audio')]);
    expect(resolveShotExecutionNode({ board: doc, executions: {}, action: 'video' }).nodeId).toBe('vid_1');
    expect(resolveShotExecutionNode({ board: doc, executions: {}, action: 'dialogue' }).nodeId).toBe('voice_1');
  });

  it('keeps the executions mapping on the shot payload', () => {
    const payload = withShotExecution({ title: 'x' }, 'storyboard', 'img_1');
    expect(readShotExecutions(payload)).toEqual({ storyboard: 'img_1' });
    expect(payload.executions).toEqual({ storyboard: 'img_1' });
  });

  it('filters adoption candidates by slot media kind', () => {
    expect(SHOT_SLOT_ASSET_KINDS.video).toEqual(['video']);
    expect(SHOT_SLOT_ASSET_KINDS.storyboard).toEqual(['image']);
    expect(SHOT_SLOT_ASSET_KINDS.firstFrame).toEqual(['image']);
    expect(SHOT_SLOT_ASSET_KINDS.lastFrame).toEqual(['image']);
    expect(SHOT_SLOT_ASSET_KINDS.dialogue).toEqual(['audio']);
  });
});
