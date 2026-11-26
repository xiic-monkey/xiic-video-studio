import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, FilePlus2, Trash2, WandSparkles } from 'lucide-react';
import { applyProductionChange, listBreakdownDrafts, saveBreakdownDraft, type ProductionEntity } from '../../services/tauri';
import { buildBreakdownThreeWayDiff, makeLocalBreakdownDraft, validateBreakdownDraft, type AppliedBreakdownShot, type BreakdownDraft } from '../../domain/production/breakdown';
import { BREAKDOWN_STALE_MESSAGE, isBreakdownDraftStale, selectBreakdownDraftForRevision, stableBreakdownDraftId } from '../breakdownDrafts';
import { payloadText } from './payloadText';

export function ScriptPanel({ projectId, scripts, shots, busy, onImport, onRefresh, onDelete }: { projectId?: string; scripts: ProductionEntity[]; shots: ProductionEntity[]; busy: boolean; onImport: () => void; onRefresh: () => Promise<void>; onDelete: (entity: ProductionEntity) => void }) {
  const [selected, setSelected] = useState<string>();
  const current = scripts.find((script) => script.id === selected) ?? scripts[0];
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<BreakdownDraft>();
  const [draftStale, setDraftStale] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [conflictDecisions, setConflictDecisions] = useState<Record<string, 'model' | 'human'>>({});
  const draftRef = useRef<BreakdownDraft | undefined>(undefined);
  const draftDirtyRef = useRef(false);
  const scriptIdRef = useRef<string | undefined>(undefined);
  const scriptDirty = Boolean(current) && (title !== payloadText(current!, 'title') || body !== payloadText(current!, 'body'));
  function updateDraft(next: BreakdownDraft | undefined, dirty = false) {
    draftRef.current = next;
    draftDirtyRef.current = dirty;
    setDraft(next);
  }
  const appliedShots = useMemo<AppliedBreakdownShot[]>(() => shots.filter((shot) => shot.payload.scriptId === current?.id && typeof shot.payload.source === 'object' && shot.payload.source !== null).map((shot) => ({
    entityId: shot.id,
    localId: String(shot.payload.localId ?? shot.id),
    source: shot.payload.source as AppliedBreakdownShot['source'],
    action: payloadText(shot, 'action'),
    dialogue: payloadText(shot, 'dialogue'),
    subjectRefs: Array.isArray(shot.payload.subjectRefs) ? shot.payload.subjectRefs.filter((item): item is string => typeof item === 'string') : [],
    selected: shot.payload.selected,
    bindings: shot.payload.bindings,
    title: payloadText(shot, 'title'),
  })), [shots, current?.id]);
  const baseline = (current?.payload.appliedBreakdown as BreakdownDraft | undefined) ?? { scriptId: current?.id ?? '', scriptRevision: 0, shots: [], subjects: [] };
  const diff = useMemo(() => draft ? buildBreakdownThreeWayDiff(draft, baseline, appliedShots) : undefined, [draft, baseline, appliedShots]);
  useEffect(() => {
    setTitle(payloadText(current ?? ({} as ProductionEntity), 'title'));
    setBody(payloadText(current ?? ({} as ProductionEntity), 'body'));
  }, [current?.id, current?.revision]);
  useEffect(() => {
    let active = true;
    if (!projectId || !current) return () => { active = false; };
    const switched = scriptIdRef.current !== current.id;
    if (switched) { scriptIdRef.current = current.id; updateDraft(undefined); setDraftStale(false); }
    void listBreakdownDrafts(projectId, current.id).then((items) => {
      if (!active) return;
      const matched = selectBreakdownDraftForRevision(items, current.revision);
      const existing = draftRef.current;
      if (existing && draftDirtyRef.current) {
        setDraftStale(isBreakdownDraftStale(existing, current.revision));
        return;
      }
      if (matched) { updateDraft(matched); setDraftStale(false); return; }
      if (existing) setDraftStale(isBreakdownDraftStale(existing, current.revision));
    }).catch((reason) => { if (active) setDraftError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [projectId, current?.id, current?.revision]);
  async function saveScript() {
    if (!projectId || !current) return;
    setSaving(true);
    setDraftError('');
    try { await applyProductionChange(projectId, crypto.randomUUID(), { [current.id]: current.revision }, [{ id: current.id, kind: 'script', payload: { ...current.payload, title, body, revision: Number(current.payload.revision ?? 1) + 1 } }]); await onRefresh(); if (draftRef.current) setDraftStale(true); }
    catch (reason) { setDraftError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  async function prepareLocalDraft() {
    if (!current || !body.trim()) return;
    const next = makeLocalBreakdownDraft(current.id, current.revision, body);
    if (!next.shots.length) { setDraftError('剧本正文没有可拆分的非空行。'); return; }
    setSaving(true);
    setDraftError('');
    try {
      await saveBreakdownDraft(projectId!, stableBreakdownDraftId(current.id, current.revision), current.id, current.revision, next);
      updateDraft(next);
      setDraftStale(false);
    } catch (reason) { setDraftError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  async function applyDraft() {
    if (!projectId || !current || !draft || scriptDirty) return;
    if (draft.scriptRevision !== current.revision) { setDraftError(`剧本已修订（当前修订 ${current.revision}），当前草案基于修订 ${draft.scriptRevision}，请重新生成草案或应用后重算。`); return; }
    const issues = validateBreakdownDraft(draft, body.replace(/\r\n?/g, '\n').split('\n').length);
    if (issues.length) { setDraftError(issues.join('、')); return; }
    if (!diff || diff.ambiguous.length) { setDraftError('锚点存在歧义，请先修正来源行，不能自动按镜号覆盖。'); return; }
    const unresolved = diff.conflicts.filter((item) => !conflictDecisions[item.draft.localId]);
    if (unresolved.length) { setDraftError('请逐项选择保留人工修改或应用草案修改。'); return; }
    // 同一剧本修订下的草案 id 稳定：带上它，重复提交不会重复创建镜头实体。
    const draftId = stableBreakdownDraftId(current.id, draft.scriptRevision);
    const operations: Array<{ id: string; kind: string; op: string; payload: Record<string, unknown> }> = [];
    for (const shot of diff.added) {
      const id = `shot_${crypto.randomUUID()}`;
      operations.push({ id, kind: 'shot', op: 'applyBreakdown', payload: { ...shot, draftId, scriptId: current.id, scriptRevision: draft.scriptRevision, order: appliedShots.length + operations.length + 1, title: `镜头 ${appliedShots.length + operations.length + 1}`, durationMs: 3000, bindings: [], selected: {}, review: 'draft' } });
    }
    for (const item of diff.changed) {
      const existing = shots.find((entity) => entity.id === item.current.entityId);
      if (!existing) continue;
      operations.push({ id: existing.id, kind: 'shot', op: 'applyBreakdown', payload: { ...existing.payload, ...item.draft, draftId, scriptId: current.id, scriptRevision: draft.scriptRevision } });
    }
    for (const item of diff.conflicts) {
      if (conflictDecisions[item.draft.localId] !== 'model') continue;
      const existing = shots.find((entity) => entity.id === item.current.entityId);
      if (!existing) continue;
      operations.push({ id: existing.id, kind: 'shot', op: 'applyBreakdown', payload: { ...existing.payload, ...item.draft, draftId, scriptId: current.id, scriptRevision: draft.scriptRevision } });
    }
    if (!operations.length) { setDraftError('没有需要应用的新增或已确认修改。'); return; }
    const appliedBreakdown = structuredClone(draft);
    const keepCurrent = [...diff.preserved, ...diff.conflicts.filter((item) => conflictDecisions[item.draft.localId] === 'human').map((item) => item.current)];
    for (const shot of keepCurrent) {
      const next = appliedBreakdown.shots.find((item) => item.source.startLine === shot.source.startLine && item.source.endLine === shot.source.endLine);
      if (next) { next.action = shot.action; next.dialogue = shot.dialogue; next.subjectRefs = [...shot.subjectRefs]; }
    }
    const expectedRevisions: Record<string, number> = { [current.id]: current.revision };
    for (const operation of operations) expectedRevisions[operation.id] = 0;
    for (const operation of operations) {
      const existing = shots.find((shot) => shot.id === operation.id);
      if (existing) expectedRevisions[operation.id] = existing.revision;
    }
    const scriptPayload = { ...current.payload, appliedBreakdown };
    operations.push({ id: current.id, kind: 'script', op: 'upsertEntity', payload: scriptPayload });
    setSaving(true); setDraftError('');
    try {
      await saveBreakdownDraft(projectId, stableBreakdownDraftId(current.id, draft.scriptRevision), current.id, draft.scriptRevision, draft);
      await applyProductionChange(projectId, crypto.randomUUID(), expectedRevisions, operations);
      updateDraft(undefined);
      setDraftStale(false);
      setConflictDecisions({});
      await onRefresh();
    } catch (reason) {
      setDraftError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSaving(false); }
  }
  return <section className="production-panel">
    <header><div><h2>剧本修订</h2><p>导入正文后，保存修订并生成可恢复的拆镜草案。</p></div><button className="studio-button" type="button" onClick={onImport} disabled={busy}><FilePlus2 size={14} /> 导入剧本</button></header>
    {!scripts.length ? <div className="production-empty">暂无剧本。支持 UTF-8 txt、md 与受限 docx 正文。</div> : <div className="production-script-grid"><aside>{scripts.map((script) => <div key={script.id} className={`production-script-item ${script.id === current?.id ? 'active' : ''}`}><button type="button" onClick={() => { setSelected(script.id); updateDraft(undefined); setDraftStale(false); }}><BookOpen size={13} />{payloadText(script, 'title') || script.id}</button><button type="button" className="production-item-remove" title="删除剧本" aria-label={`删除剧本 ${payloadText(script, 'title') || script.id}`} onClick={() => { void onDelete(script); }}><Trash2 size={12} /></button></div>)}</aside><article><div className="production-meta"><span>修订 {current?.revision}</span><span>{payloadText(current!, 'displayName')}</span></div><label className="production-script-title">标题<input value={title} onChange={(event) => { setTitle(event.target.value); if (draftRef.current) setDraftStale(true); }} /></label><label className="production-script-body">正文<textarea value={body} onChange={(event) => { setBody(event.target.value); if (draftRef.current) setDraftStale(true); }} /></label>{scriptDirty && <p className="production-error" role="status">剧本有未保存修改；先保存修订，再生成或应用拆镜草案。</p>}<div className="production-actions"><button type="button" onClick={() => void saveScript()} disabled={saving || busy}>保存修订</button><button type="button" onClick={() => void prepareLocalDraft()} disabled={!body.trim() || scriptDirty || saving || busy}><WandSparkles size={14} /> 生成本地拆镜草案</button></div><div className="production-next"><Check size={14} /> 草案按非空行创建，可逐镜编辑；不会调用模型或产生费用。</div>{draft && draftStale && <p className="production-error" role="status">{BREAKDOWN_STALE_MESSAGE}（草案基于剧本修订 {draft.scriptRevision}，当前剧本修订 {current?.revision}）</p>}{draft && diff && <div className="breakdown-review"><header><b>待应用草案 · {draft.shots.length} 镜</b><button type="button" onClick={() => { updateDraft(undefined); setDraftStale(false); }}>丢弃草案</button></header><p>新增 {diff.added.length} · 需更新 {diff.changed.length} · 人工修改保留 {diff.preserved.length} · 冲突 {diff.conflicts.length} · 歧义 {diff.ambiguous.length}</p>{draft.shots.map((shot, index) => <label key={shot.localId}>镜头 {index + 1} · 原文第 {shot.source.startLine} 行<input value={shot.action} onChange={(event) => updateDraft({ ...draft, shots: draft.shots.map((item) => item.localId === shot.localId ? { ...item, action: event.target.value } : item) }, true)} /></label>)}{diff.conflicts.map((item) => <label key={item.draft.localId}>镜头 {item.draft.localId} · 当前有人工修改<select aria-label={`冲突处理 ${item.draft.localId}`} value={conflictDecisions[item.draft.localId] ?? ''} onChange={(event) => setConflictDecisions((value) => ({ ...value, [item.draft.localId]: event.target.value as 'model' | 'human' }))}><option value="">选择处理方式</option><option value="human">保留人工版本</option><option value="model">应用草案版本</option></select></label>)}<button type="button" onClick={() => void applyDraft()} disabled={saving || busy || scriptDirty || !draft.shots.length}>一次应用草案</button></div>}{draftError && <p className="production-error" role="alert">{draftError}</p>}</article></div>}
  </section>;
}

