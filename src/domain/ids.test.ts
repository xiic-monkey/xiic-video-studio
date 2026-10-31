import { describe, expect, it } from 'vitest';
import { newId } from './ids';

describe('newId', () => {
  it('prefixes a uuid', () => {
    expect(newId('board')).toMatch(/^board_[0-9a-f-]{36}$/);
  });

  it('is unique', () => {
    expect(newId('node')).not.toBe(newId('node'));
  });
});
