import { describe, expect, it } from 'vitest';
import { makeDoc, node } from '../graph/testFixtures';
import { characterSheetInstruction, inpaintInstruction, storyboardGridInstruction } from './templates';
import { createNode } from './definitions';

describe('业务节点提示词模板', () => {
  it('角色三视图：横版给「面部特写 + 正/侧/背」，竖版给 2×2 四视图', () => {
    const landscape = createNode('character', { x: 0, y: 0 });
    const portrait = createNode('character', { x: 0, y: 0 }, { layout: 'portrait' });
    const landscapeText = characterSheetInstruction(landscape);
    const portraitText = characterSheetInstruction(portrait);
    expect(landscapeText).toContain('面部特写');
    expect(landscapeText).toContain('背面全身');
    expect(portraitText).toContain('2×2');
    expect(landscapeText).toContain('只露出一只眼睛');
    expect(landscapeText).toContain('不要文字');
  });

  it('分镜九宫格按宫格数描述画格数量', () => {
    const grid = createNode('storyboard', { x: 0, y: 0 });
    const wide = createNode('storyboard', { x: 0, y: 0 }, { grid: '4x4' });
    expect(storyboardGridInstruction(grid)).toContain('9 个');
    expect(storyboardGridInstruction(wide)).toContain('16 个');
  });

  it('局部重绘：约束只改蒙版区域并带上补充要求', () => {
    const base = createNode('inpaint', { x: 0, y: 0 });
    const text = inpaintInstruction(base);
    expect(text).toContain('只重绘蒙版标记的白色区域');
    const noted = inpaintInstruction(createNode('inpaint', { x: 0, y: 0 }, { note: '保留光线' }));
    expect(noted).toContain('保留光线');
  });

  it('业务节点走图片能力', () => {
    const doc = makeDoc([node('c', 'character', { prompt: '一个短发女侦探' })], []);
    expect(doc.nodes.c.type).toBe('character');
  });
});
