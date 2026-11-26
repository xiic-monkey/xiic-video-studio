import { describe, expect, it } from 'vitest';
import { keyStatusLabel, nodeCategoryLabel, reviewLabel, subjectKindLabel } from './labels';

describe('production labels', () => {
  it('审批状态给出中文名', () => {
    expect(reviewLabel('draft')).toBe('草稿');
    expect(reviewLabel('review')).toBe('待审');
    expect(reviewLabel('approved')).toBe('已通过');
    expect(reviewLabel('rejected')).toBe('已驳回');
  });

  it('未知审批状态原样返回，不吞掉信息', () => {
    expect(reviewLabel('weird')).toBe('weird');
    expect(reviewLabel(undefined)).toBe('草稿');
  });

  it('主体类型给出中文名', () => {
    expect(subjectKindLabel('character')).toBe('角色');
    expect(subjectKindLabel('location')).toBe('地点');
    expect(subjectKindLabel('prop')).toBe('道具');
  });

  it('节点类别给出中文名', () => {
    expect(nodeCategoryLabel('character')).toBe('角色');
    expect(nodeCategoryLabel('shot')).toBe('镜头');
    expect(nodeCategoryLabel('unknown')).toBe('unknown');
  });

  it('Key 状态区分未保存与可用', () => {
    expect(keyStatusLabel('active', false)).toBe('未保存');
    expect(keyStatusLabel('active', true)).toBe('可用');
    expect(keyStatusLabel('invalid', true)).toBe('已失效');
  });
});
