import { beforeEach, describe, expect, it } from 'vitest';
import { copyNodes, pasteNodes, resetClipboard } from './clipboard';
import { makeDoc, node } from '../domain/graph/testFixtures';

describe('canvas clipboard', () => {
  beforeEach(() => {
    resetClipboard();
  });

  it('复制后粘贴出等量节点，且是新 id', () => {
    const doc = makeDoc([node('n1', 'image'), node('n2', 'video')], []);
    expect(copyNodes(doc, ['n1', 'n2'])).toBe(2);
    const pasted = pasteNodes(doc);
    expect(pasted).toHaveLength(2);
    expect(pasted!.map((item) => item.id)).not.toContain('n1');
    expect(pasted!.every((item) => item.id.startsWith('node_'))).toBe(true);
  });

  it('粘贴出的节点与原节点内容一致，但位置错开', () => {
    const doc = makeDoc([{ ...node('n1', 'image'), position: { x: 10, y: 20 } }], []);
    copyNodes(doc, ['n1']);
    const pasted = pasteNodes(doc)![0];
    expect(pasted.type).toBe('image');
    expect(pasted.data).toEqual(doc.nodes.n1.data);
    expect(pasted.position).toEqual({ x: 50, y: 60 });
  });

  it('剪贴板按画布隔离：别的画布粘贴不出来', () => {
    const source = makeDoc([node('n1', 'image')], []);
    copyNodes(source, ['n1']);
    const other = { ...makeDoc([node('n1', 'image')], []), id: 'other-board' };
    expect(pasteNodes(other)).toBeUndefined();
  });

  it('没有复制过就粘贴，返回空', () => {
    const doc = makeDoc([node('n1', 'image')], []);
    expect(pasteNodes(doc)).toBeUndefined();
  });

  it('复制不存在的节点不产生剪贴板内容', () => {
    const doc = makeDoc([node('n1', 'image')], []);
    expect(copyNodes(doc, ['ghost'])).toBe(0);
    expect(pasteNodes(doc)).toBeUndefined();
  });
});
