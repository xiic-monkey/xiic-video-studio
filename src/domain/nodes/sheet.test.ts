import { describe, expect, it } from 'vitest';
import { createNode } from './definitions';
import { referenceIdsOf, splitLayoutFor, viewsOf } from './sheet';

describe('拆帧与参考图', () => {
  it('按节点类型给出拆帧版式', () => {
    const character = createNode('character', { x: 0, y: 0 });
    expect(splitLayoutFor(character)).toBe('landscape');
    const portrait = createNode('character', { x: 0, y: 0 }, { layout: 'portrait' });
    expect(splitLayoutFor(portrait)).toBe('portrait');
    const grid = createNode('storyboard', { x: 0, y: 0 }, { grid: '4x4' });
    expect(splitLayoutFor(grid)).toBe('4x4');
    const turn = createNode('turnaround', { x: 0, y: 0 }, { steps: 16 });
    expect(splitLayoutFor(turn)).toBe('strip:16');
    expect(splitLayoutFor(createNode('text', { x: 0, y: 0 }))).toBeUndefined();
  });

  it('读出节点上已拆出的视角与参考图', () => {
    const node = createNode('character', { x: 0, y: 0 }, {
      views: [{ view: 'front', label: '正面', assetId: 'asset_a' }],
      referenceAssetIds: ['asset_a', 'bad'],
    });
    expect(viewsOf(node)).toHaveLength(1);
    expect(referenceIdsOf(node)).toEqual(['asset_a', 'bad']);
    const empty = createNode('character', { x: 0, y: 0 });
    expect(viewsOf(empty)).toEqual([]);
    expect(referenceIdsOf(empty)).toEqual([]);
  });
});
