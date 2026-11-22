import { describe, expect, it } from 'vitest';
import { moveShotToScene, renameStructureEntity, reorderStructureSiblings } from './navigationEdits';

const entity = (id: string, kind: string, payload: Record<string, unknown>, revision = 1) => ({ id, kind, payload, revision });

describe('production navigation edits', () => {
  it('renames an episode or scene without changing its stable id', () => {
    expect(renameStructureEntity(entity('ep', 'episode', { title: '旧集', order: 1 }), '新集')).toEqual({ title: '新集', order: 1 });
    expect(renameStructureEntity(entity('scene', 'scene', { heading: '旧场', episodeId: 'ep' }), '新场')).toEqual({ heading: '新场', episodeId: 'ep' });
  });

  it('moves a shot to a scene and derives the scene episode', () => {
    const result = moveShotToScene(
      entity('shot', 'shot', { title: '镜头', episodeId: 'old', sceneId: 'old-scene', order: 2 }),
      entity('new-scene', 'scene', { episodeId: 'new', heading: '新场' }),
      [entity('other', 'shot', { sceneId: 'new-scene', episodeId: 'new', order: 1 })],
    );
    expect(result).toMatchObject({ title: '镜头', sceneId: 'new-scene', episodeId: 'new', order: 2 });
  });

  it('swaps sibling order without touching unrelated parents', () => {
    const siblings = [
      entity('a', 'scene', { episodeId: 'ep', order: 1 }),
      entity('b', 'scene', { episodeId: 'ep', order: 2 }),
      entity('c', 'scene', { episodeId: 'other', order: 1 }),
    ];
    expect(reorderStructureSiblings(siblings, 'b', 'up').map((item) => [item.id, item.payload.order])).toEqual([
      ['a', 2], ['b', 1], ['c', 1],
    ]);
  });
});
