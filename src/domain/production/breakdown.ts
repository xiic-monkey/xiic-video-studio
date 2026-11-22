export interface BreakdownShot { localId: string; source: { startLine: number; endLine: number }; action: string; dialogue: string; subjectRefs: string[] }
export interface BreakdownDraft { scriptId: string; scriptRevision: number; shots: BreakdownShot[]; subjects: string[] }
export interface BreakdownDiff { added: BreakdownShot[]; changed: BreakdownShot[]; unchanged: BreakdownShot[]; ambiguous: BreakdownShot[] }
export interface AppliedBreakdownShot extends BreakdownShot { entityId: string; selected?: unknown; bindings?: unknown; title?: string }
export interface BreakdownThreeWayDiff {
  added: BreakdownShot[];
  changed: Array<{ draft: BreakdownShot; current: AppliedBreakdownShot }>;
  preserved: AppliedBreakdownShot[];
  unchanged: AppliedBreakdownShot[];
  conflicts: Array<{ draft: BreakdownShot; baseline: BreakdownShot; current: AppliedBreakdownShot }>;
  removed: AppliedBreakdownShot[];
  ambiguous: BreakdownShot[];
}

export function makeLocalBreakdownDraft(scriptId: string, scriptRevision: number, body: string): BreakdownDraft {
  const lines = body.replace(/\r\n?/g, '\n').split('\n').map((text, index) => ({ text: text.trim(), line: index + 1 })).filter((line) => line.text);
  return {
    scriptId,
    scriptRevision,
    subjects: [],
    shots: lines.slice(0, 100).map((line, index) => ({
      localId: `local-shot-${index + 1}`,
      source: { startLine: line.line, endLine: line.line },
      action: line.text,
      dialogue: /[“”"「」:：]/.test(line.text) ? line.text : '',
      subjectRefs: [],
    })),
  };
}

export function validateBreakdownDraft(draft: BreakdownDraft, lineCount: number): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const shot of draft.shots) {
    if (!shot.localId || ids.has(shot.localId)) issues.push('BREAKDOWN_LOCAL_ID_INVALID');
    ids.add(shot.localId);
    if (shot.source.startLine < 1 || shot.source.endLine < shot.source.startLine || shot.source.endLine > lineCount) issues.push(`BREAKDOWN_SOURCE_RANGE:${shot.localId}`);
    if (!shot.action.trim()) issues.push(`BREAKDOWN_ACTION_EMPTY:${shot.localId}`);
    if (shot.subjectRefs.some((id) => !draft.subjects.includes(id))) issues.push(`BREAKDOWN_SUBJECT_UNKNOWN:${shot.localId}`);
  }
  return issues;
}

export function buildBreakdownDiff(draft: BreakdownDraft, baseline: BreakdownDraft | undefined): BreakdownDiff {
  if (!baseline) return { added: draft.shots, changed: [], unchanged: [], ambiguous: [] };
  const byAnchor = new Map(baseline.shots.map((shot) => [`${shot.source.startLine}:${shot.source.endLine}`, shot]));
  const added: BreakdownShot[] = [], changed: BreakdownShot[] = [], unchanged: BreakdownShot[] = [], ambiguous: BreakdownShot[] = [];
  for (const shot of draft.shots) {
    const existing = byAnchor.get(`${shot.source.startLine}:${shot.source.endLine}`);
    if (!existing) { added.push(shot); continue; }
    if (existing.action === shot.action && existing.dialogue === shot.dialogue && JSON.stringify(existing.subjectRefs) === JSON.stringify(shot.subjectRefs)) unchanged.push(shot);
    else changed.push(shot);
  }
  const anchors = draft.shots.map((shot) => `${shot.source.startLine}:${shot.source.endLine}`);
  for (const shot of baseline.shots) if (anchors.filter((anchor) => anchor === `${shot.source.startLine}:${shot.source.endLine}`).length > 1) ambiguous.push(shot);
  return { added, changed, unchanged, ambiguous };
}

function anchorOf(shot: BreakdownShot): string {
  return `${shot.source.startLine}:${shot.source.endLine}`;
}

function sameCreativeContent(left: BreakdownShot, right: BreakdownShot): boolean {
  return left.action === right.action && left.dialogue === right.dialogue && [...left.subjectRefs].sort().join('\0') === [...right.subjectRefs].sort().join('\0');
}

export function buildBreakdownThreeWayDiff(
  draft: BreakdownDraft,
  baseline: BreakdownDraft,
  current: readonly AppliedBreakdownShot[],
): BreakdownThreeWayDiff {
  const result: BreakdownThreeWayDiff = { added: [], changed: [], preserved: [], unchanged: [], conflicts: [], removed: [], ambiguous: [] };
  const draftCounts = new Map<string, number>();
  const baselineCounts = new Map<string, number>();
  const currentCounts = new Map<string, number>();
  for (const shot of draft.shots) draftCounts.set(anchorOf(shot), (draftCounts.get(anchorOf(shot)) ?? 0) + 1);
  for (const shot of baseline.shots) baselineCounts.set(anchorOf(shot), (baselineCounts.get(anchorOf(shot)) ?? 0) + 1);
  for (const shot of current) currentCounts.set(anchorOf(shot), (currentCounts.get(anchorOf(shot)) ?? 0) + 1);
  const baselineByAnchor = new Map(baseline.shots.map((shot) => [anchorOf(shot), shot]));
  const currentByAnchor = new Map(current.map((shot) => [anchorOf(shot), shot]));
  const matched = new Set<string>();
  for (const next of draft.shots) {
    const anchor = anchorOf(next);
    if ((draftCounts.get(anchor) ?? 0) > 1 || (baselineCounts.get(anchor) ?? 0) > 1 || (currentCounts.get(anchor) ?? 0) > 1) {
      result.ambiguous.push(next);
      continue;
    }
    const previous = baselineByAnchor.get(anchor);
    if (!previous) { result.added.push(next); continue; }
    matched.add(anchor);
    const live = currentByAnchor.get(anchor);
    if (!live) { result.ambiguous.push(next); continue; }
    const modelChanged = !sameCreativeContent(previous, next);
    const humanChanged = !sameCreativeContent(previous, live);
    if (!modelChanged && !humanChanged) result.unchanged.push(live);
    else if (modelChanged && !humanChanged) result.changed.push({ draft: next, current: live });
    else if (!modelChanged && humanChanged) result.preserved.push(live);
    else if (sameCreativeContent(next, live)) result.unchanged.push(live);
    else result.conflicts.push({ draft: next, baseline: previous, current: live });
  }
  for (const shot of current) {
    if ((currentCounts.get(anchorOf(shot)) ?? 0) === 1 && baselineByAnchor.has(anchorOf(shot)) && !matched.has(anchorOf(shot)) && !draft.shots.some((candidate) => anchorOf(candidate) === anchorOf(shot))) {
      result.removed.push(shot);
    }
  }
  return result;
}
