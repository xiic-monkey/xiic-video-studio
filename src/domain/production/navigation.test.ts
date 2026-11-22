import { describe, expect, it } from 'vitest';
import { buildProductionNavigation } from './navigation';

describe('production navigation', () => {
  it('groups scenes and shots under episodes while retaining ungrouped shots', () => {
    const tree = buildProductionNavigation([
      { id: 'ep-1', kind: 'episode', payload: { order: 1, title: '第一集' } },
      { id: 'scene-1', kind: 'scene', payload: { episodeId: 'ep-1', order: 1, heading: '室内' } },
      { id: 'shot-1', kind: 'shot', payload: { sceneId: 'scene-1', order: 1, title: '开门' } },
      { id: 'shot-2', kind: 'shot', payload: { order: 2, title: '未分组' } },
    ]);

    expect(tree.children.map((node) => node.label)).toEqual(['第一集', '未分组镜头']);
    expect(tree.children[0].children[0].children[0].id).toBe('shot-1');
    expect(tree.children[1].shotIds).toEqual(['shot-2']);
  });

  it('uses stable fallback labels without changing entity ids', () => {
    const tree = buildProductionNavigation([{ id: 'shot-9', kind: 'shot', payload: { order: 9 } }]);
    expect(tree.children[0]).toMatchObject({ id: 'ungrouped-shots', kind: 'ungrouped' });
    expect(tree.children[0].children[0]).toMatchObject({ id: 'shot-9', label: '镜头 9' });
  });
});
