import { describe, expect, it } from 'vitest';
import { canConfirmExport, createLocalCompose } from './timelineController';
describe('timeline controller', () => {
  it('creates compose in confirmed order without provider', () => expect(createLocalCompose('p','b',[{ id: 'a', duration: 4 }, { id: 'b', duration: 2 }]).clips.map((clip) => clip.assetId)).toEqual(['a','b']));
  it('uses probed source duration for the initial clip range', () => expect(createLocalCompose('p','b',[{ id: 'a', duration: 4 }]).clips[0]).toMatchObject({ sourceInTicks: 0, sourceOutTicks: 960_000 }));
  it('cannot confirm blocking preflight issue', () => expect(canConfirmExport({ timeline: createLocalCompose('p','b',[{ id: 'a', duration: 4 }]), exportRevision: 0, exportStatus: 'idle' }, {})).toBe(false));
});
