import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node } from './testFixtures';
import { topoSort } from './topo';

describe('topoSort', () => {
  it('orders upstream before downstream', () => {
    const doc = makeDoc(
      [node('a', 'text'), node('b', 'image'), node('c', 'video')],
      [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')],
    );
    expect(topoSort(doc).order).toEqual(['a', 'b', 'c']);
    expect(topoSort(doc).cycle).toEqual([]);
  });

  it('reports cycles', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'text')], [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')]);
    const result = topoSort(doc);
    expect(result.cycle.sort()).toEqual(['a', 'b']);
  });
});
