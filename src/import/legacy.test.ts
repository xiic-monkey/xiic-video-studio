import { describe, expect, it } from 'vitest';
import { summarizeImport } from './legacy';

describe('summarizeImport', () => {
  it('reports counts and truncates warnings', () => {
    const text = summarizeImport({
      project: { id: 'project_1' },
      board: { id: 'board_1' },
      assetCount: 12,
      runCount: 9,
      warnings: ['警告一', '警告二', '警告三', '警告四', '警告五', '警告六'],
    });
    expect(text).toContain('导入 12 个素材');
    expect(text).toContain('生成 9 条导入记录');
    expect(text).toContain('警告四');
    expect(text).toContain('还有 2 条');
  });

  it('says nothing went wrong when warnings are empty', () => {
    expect(summarizeImport({ project: {}, board: {}, assetCount: 0, runCount: 0, warnings: [] }))
      .toBe('没有导入任何素材：旧项目可能还没有生成结果。');
  });
});
