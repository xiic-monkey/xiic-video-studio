import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical';
import { sha256Hex } from './hash';

describe('canonicalJson', () => {
  it('sorts object keys and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
  });

  it('drops undefined object fields but keeps null array slots', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: [undefined, 2] })).toBe('{"b":1,"c":[null,2]}');
  });

  it('is stable for nested structures', () => {
    expect(canonicalJson({ z: [{ y: 1, x: 2 }], a: true })).toBe('{"a":true,"z":[{"x":2,"y":1}]}');
  });
});

describe('sha256Hex', () => {
  it('matches the known abc vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
