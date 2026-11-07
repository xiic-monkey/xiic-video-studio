import { describe, expect, it } from 'vitest';
import { safeExportName } from './exportName';

describe('safeExportName', () => {
  it('replaces reserved characters and appends the id tail', () => {
    expect(safeExportName({ name: '雨夜/追凶:第一集', id: 'project_abc123' })).toBe('雨夜_追凶_第一集-abc123.json');
  });

  it('falls back when the project name has nothing usable', () => {
    expect(safeExportName({ name: '   ', id: 'project_zzz999' })).toBe('frameforge-project-zzz999.json');
  });

  it('caps the length so long names stay writable', () => {
    const long = safeExportName({ name: 'x'.repeat(200), id: 'project_111111' });
    expect(long.length).toBeLessThanOrEqual(70);
  });

  it('keeps remote url style slashes out of the name', () => {
    expect(safeExportName({ name: 'https://example.com/a', id: 'project_abc123' })).toBe('https___example.com_a-abc123.json');
  });

  it('does not leave a dangling separator when the id is empty', () => {
    expect(safeExportName({ name: '短剧', id: '' })).toBe('短剧.json');
  });
});
