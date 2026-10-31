import { describe, expect, it } from 'vitest';
import { emptyStyleGuide } from '../types';
import { compilePrompt } from './compile';

const styleGuide = { ...emptyStyleGuide(), visualStyle: '冷色写实电影感', version: 2 };

describe('compilePrompt', () => {
  it('replaces style variables and records segments', () => {
    const result = compilePrompt('{{style.visualStyle}}，雨夜街头，{{mood}}', {
      variables: { mood: '压抑' }, styleGuide,
    });
    expect(result.text).toBe('冷色写实电影感，雨夜街头，压抑');
    expect(result.segments.map((segment) => segment.key)).toEqual(['style', 'literal', 'variable']);
    expect(result.missingVariables).toEqual([]);
  });

  it('keeps unknown variables visible and reports them', () => {
    const result = compilePrompt('{{unknown}} 镜头', { variables: {}, styleGuide });
    expect(result.text).toBe('{{unknown}} 镜头');
    expect(result.missingVariables).toEqual(['unknown']);
  });

  it('uses locked text verbatim and hashes deterministically', () => {
    const first = compilePrompt('{{style.visualStyle}} 模板', { variables: {}, styleGuide, lockedText: '锁定提示词' });
    const second = compilePrompt('{{style.visualStyle}} 模板', { variables: {}, styleGuide, lockedText: '锁定提示词' });
    expect(first.text).toBe('锁定提示词');
    expect(first.locked).toBe(true);
    expect(first.hash).toBe(second.hash);
  });

  it('changes hash when negative changes', () => {
    const base = compilePrompt('镜头', { variables: {}, styleGuide, negative: '模糊' });
    const other = compilePrompt('镜头', { variables: {}, styleGuide, negative: '过曝' });
    expect(base.hash).not.toBe(other.hash);
  });
});
