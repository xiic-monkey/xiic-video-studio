import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('runs in node with crypto available', () => {
    expect(typeof process).toBe('object');
    expect(typeof crypto.randomUUID).toBe('function');
  });
});
