import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BookOpen, Check, FilePlus2, Layers3, ListTree, RefreshCw, UserRound, WandSparkles } from 'lucide-react';
import { adoptShotMedia, applyProductionChange, importScriptDocument, listAssets, listBreakdownDrafts, listProductionEntityPage, listRuns, pickScriptFile, recordProductionReview, saveBreakdownDraft, type ProductionEntity } from '../services/tauri';
import { buildBreakdownThreeWayDiff, makeLocalBreakdownDraft, validateBreakdownDraft, type AppliedBreakdownShot, type BreakdownDraft } from '../domain/production/breakdown';
import { shotSpecHash } from '../domain/production/shots';
import { buildEpisodeAssembly } from '../domain/production/assembly';
import { buildProductionNavigation, type ProductionNavigationNode } from '../domain/production/navigation';
import { moveShotToScene, renameStructureEntity, reorderStructureSiblings } from '../domain/production/navigationEdits';
import { useRunController } from '../run/controller';
import { useBoardStore } from '../stores/boardStore';
import { BREAKDOWN_STALE_MESSAGE, isBreakdownDraftStale, selectBreakdownDraftForRevision, stableBreakdownDraftId } from './breakdownDrafts';
import { readShotExecutions, resolveShotExecutionNode, SHOT_ACTIONS, SHOT_ACTION_LABELS, SHOT_SLOT_ASSET_KINDS, SHOT_SLOT_LABELS, SHOT_SLOTS, withShotExecution, type ShotAction, type ShotSlot } from './shotExecution';
import { describeReviewError, nextReviewStates } from './shotReview';
import type { AssetRef, RunRecord } from '../domain/types';

type WorkspaceTab = 'script' | 'subjects' | 'shots';

function payloadText(entity: ProductionEntity, key: string): string {
  const value = entity?.payload?.[key];
  return typeof value === 'string' ? value : '';
}

export function ProductionWorkspace({ projectId, boardId }: { projectId?: string; boardId?: string }) {
  const [tab, setTab] = useState<WorkspaceTab>('script');
  const [entities, setEntities] = useState<ProductionEntity[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!projectId) return;
    try { setEntities(await listProductionEntityPage(projectId)); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  const scripts = useMemo(() => entities.filter((entity) => entity.kind === 'script'), [entities]);
  const subjects = useMemo(() => entities.filter((entity) => entity.kind === 'subject'), [entities]);
  const shots = useMemo(() => entities.filter((entity) => entity.kind === 'shot'), [entities]);

  async function importScript() {
    if (!projectId) return;
    setBusy(true); setError('');
    try {
      const grant = await pickScriptFile(projectId);
      if (!grant) return;
      const document = await importScriptDocument(projectId, grant.id);
      const id = `script_${crypto.randomUUID()}`;
      await applyProductionChange(projectId, crypto.randomUUID(), { [id]: 0 }, [{ id, kind: 'script', payload: { title: document.title, body: document.body, displayName: document.displayName, revision: 1 } }]);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function addSubject(name: string, kind: string, descriptor: string) {
    if (!projectId) return;
    setBusy(true); setError('');
    try {
      const id = `subject_${crypto.randomUUID()}`;
      await applyProductionChange(projectId, crypto.randomUUID(), { [id]: 0 }, [{ id, kind: 'subject', op: 'createSubjectVersion', payload: { name, kind, aliases: [], version: { ordinal: 1, descriptor, references: [] } } }]);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function addShot() {
    if (!projectId || !boardId) return;
    setBusy(true); setError('');
    try {
      const id = `shot_${crypto.randomUUID()}`;
      await applyProductionChange(projectId, crypto.randomUUID(), { [id]: 0 }, [{ id, kind: 'shot', payload: { projectId, boardId, order: shots.length + 1, title: `镜头 ${shots.length + 1}`, action: '', dialogue: '', durationMs: 3000, bindings: [], selected: {}, review: 'draft' } }]);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return (
    <div className="production-workspace">
      <header className="production-toolbar">
        <div><span className="studio-eyebrow">Production</span><h1>剧本与镜头</h1><p>项目级实体与画布共用同一修订、素材和审批记录。</p></div>
        <button type="button" className="studio-icon-button" title="刷新制作数据" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} /></button>
      </header>
      <nav className="production-tabs" aria-label="制作视图">
        <button type="button" className={tab === 'script' ? 'active' : ''} onClick={() => setTab('script')}><BookOpen size={14} /> 剧本</button>
        <button type="button" className={tab === 'subjects' ? 'active' : ''} onClick={() => setTab('subjects')}><UserRound size={14} /> 主体 ({subjects.length})</button>
        <button type="button" className={tab === 'shots' ? 'active' : ''} onClick={() => setTab('shots')}><Layers3 size={14} /> 镜头 ({shots.length})</button>
      </nav>
  {tab === 'script' && <ScriptPanel projectId={projectId} scripts={scripts} shots={shots} busy={busy} onImport={() => void importScript()} onRefresh={refresh} />}
      {tab === 'subjects' && <SubjectLibrary projectId={projectId} subjects={subjects} busy={busy} onAdd={(name, kind, descriptor) => void addSubject(name, kind, descriptor)} onRefresh={() => void refresh()} />}
  {tab === 'shots' && <ShotList projectId={projectId} boardId={boardId} entities={entities} shots={shots} subjects={subjects} busy={busy} onAdd={() => void addShot()} onRefresh={() => void refresh()} />}
      {error && <p className="production-error" role="alert">{error}</p>}
    </div>
  );
}

function ScriptPanel({ projectId, scripts, shots, busy, onImport, onRefresh }: { projectId?: string; scripts: ProductionEntity[]; shots: ProductionEntity[]; busy: boolean; onImport: () => void; onRefresh: () => Promise<void> }) {
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
    try { await applyProductionChange(projectId, crypto.randomUUID(), { [current.id]: current.revision }, [{ id: current.id, kind: 'script', payload: { ...current.payload, title, body, revision: Number(current.payload.revision ?? 1) + 1 } }]); await onRefresh(); if (draftRef.current) setDraftStale(true); }
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
    {!scripts.length ? <div className="production-empty">暂无剧本。支持 UTF-8 txt、md 与受限 docx 正文。</div> : <div className="production-script-grid"><aside>{scripts.map((script) => <button type="button" key={script.id} className={script.id === current?.id ? 'active' : ''} onClick={() => { setSelected(script.id); updateDraft(undefined); setDraftStale(false); }}><BookOpen size={13} />{payloadText(script, 'title') || script.id}</button>)}</aside><article><div className="production-meta"><span>修订 {current?.revision}</span><span>{payloadText(current!, 'displayName')}</span></div><label className="production-script-title">标题<input value={title} onChange={(event) => { setTitle(event.target.value); if (draftRef.current) setDraftStale(true); }} /></label><label className="production-script-body">正文<textarea value={body} onChange={(event) => { setBody(event.target.value); if (draftRef.current) setDraftStale(true); }} /></label>{scriptDirty && <p className="production-error" role="status">剧本有未保存修改；先保存修订，再生成或应用拆镜草案。</p>}<div className="production-actions"><button type="button" onClick={() => void saveScript()} disabled={saving || busy}>保存修订</button><button type="button" onClick={() => void prepareLocalDraft()} disabled={!body.trim() || scriptDirty || saving || busy}><WandSparkles size={14} /> 生成本地拆镜草案</button></div><div className="production-next"><Check size={14} /> 草案按非空行创建，可逐镜编辑；不会调用模型或产生费用。</div>{draft && draftStale && <p className="production-error" role="status">{BREAKDOWN_STALE_MESSAGE}（草案基于剧本修订 {draft.scriptRevision}，当前剧本修订 {current?.revision}）</p>}{draft && diff && <div className="breakdown-review"><header><b>待应用草案 · {draft.shots.length} 镜</b><button type="button" onClick={() => { updateDraft(undefined); setDraftStale(false); }}>丢弃草案</button></header><p>新增 {diff.added.length} · 需更新 {diff.changed.length} · 人工修改保留 {diff.preserved.length} · 冲突 {diff.conflicts.length} · 歧义 {diff.ambiguous.length}</p>{draft.shots.map((shot, index) => <label key={shot.localId}>镜头 {index + 1} · 原文第 {shot.source.startLine} 行<input value={shot.action} onChange={(event) => updateDraft({ ...draft, shots: draft.shots.map((item) => item.localId === shot.localId ? { ...item, action: event.target.value } : item) }, true)} /></label>)}{diff.conflicts.map((item) => <label key={item.draft.localId}>镜头 {item.draft.localId} · 当前有人工修改<select aria-label={`冲突处理 ${item.draft.localId}`} value={conflictDecisions[item.draft.localId] ?? ''} onChange={(event) => setConflictDecisions((value) => ({ ...value, [item.draft.localId]: event.target.value as 'model' | 'human' }))}><option value="">选择处理方式</option><option value="human">保留人工版本</option><option value="model">应用草案版本</option></select></label>)}<button type="button" onClick={() => void applyDraft()} disabled={saving || busy || scriptDirty || !draft.shots.length}>一次应用草案</button></div>}{draftError && <p className="production-error" role="alert">{draftError}</p>}</article></div>}
  </section>;
}

function SubjectLibrary({ projectId, subjects, busy, onAdd, onRefresh }: { projectId?: string; subjects: ProductionEntity[]; busy: boolean; onAdd: (name: string, kind: string, descriptor: string) => void; onRefresh: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('character');
  const [descriptor, setDescriptor] = useState('');
  return <section className="production-panel"><header><div><h2>主体库</h2><p>角色、地点和道具使用不可变版本，镜头绑定具体版本。</p></div></header><form className="subject-create-form" onSubmit={(event) => { event.preventDefault(); if (!name.trim() || !descriptor.trim()) return; onAdd(name.trim(), kind, descriptor.trim()); setName(''); setDescriptor(''); }}><input aria-label="主体名称" placeholder="名称" value={name} onChange={(event) => setName(event.target.value)} /><select aria-label="主体类型" value={kind} onChange={(event) => setKind(event.target.value)}><option value="character">角色</option><option value="location">地点</option><option value="prop">道具</option></select><input aria-label="身份描述" placeholder="身份描述" value={descriptor} onChange={(event) => setDescriptor(event.target.value)} /><button className="studio-button" type="submit" disabled={busy || !name.trim() || !descriptor.trim()}><UserRound size={14} /> 新建主体</button></form><div className="production-card-grid">{subjects.map((subject) => <article className="production-card" key={subject.id}><header><b>{payloadText(subject, 'name') || subject.id}</b><span>{payloadText(subject, 'kind') || 'character'}</span></header><p>{Array.isArray(subject.payload.aliases) ? `${subject.payload.aliases.length} 个别名` : '未设置别名'}</p><small>当前版本 v{String(subject.payload.currentVersion ?? 1)} · 修订 {subject.revision}</small><details className="subject-version-editor"><summary>添加版本</summary><SubjectVersionForm projectId={projectId} subject={subject} onRefresh={onRefresh} /></details></article>)}{!subjects.length && <div className="production-empty">还没有主体档案。</div>}</div></section>;
}

function SubjectVersionForm({ projectId, subject, onRefresh }: { projectId?: string; subject: ProductionEntity; onRefresh: () => void }) {
  const [descriptor, setDescriptor] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!projectId || !descriptor.trim()) return;
    const ordinal = Number(subject.payload.currentVersion ?? 1) + 1;
    setSaving(true);
    try { await applyProductionChange(projectId, crypto.randomUUID(), { [subject.id]: subject.revision }, [{ id: subject.id, kind: 'subject', op: 'createSubjectVersion', payload: { ...subject.payload, version: { ordinal, descriptor: descriptor.trim(), references: [] } } }]); setDescriptor(''); onRefresh(); }
    finally { setSaving(false); }
  }
  return <div className="subject-version-form"><textarea aria-label="新版本身份描述" value={descriptor} onChange={(event) => setDescriptor(event.target.value)} placeholder="新版本身份描述" /><button type="button" onClick={() => void save()} disabled={saving || !descriptor.trim()}>保存 v{Number(subject.payload.currentVersion ?? 1) + 1}</button></div>;
}

function ShotList({ projectId, boardId, entities, shots, subjects, busy, onAdd, onRefresh }: { projectId?: string; boardId?: string; entities: ProductionEntity[]; shots: ProductionEntity[]; subjects: ProductionEntity[]; busy: boolean; onAdd: () => void; onRefresh: () => void }) {
  const [assets, setAssets] = useState<AssetRef[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [episodeTitle, setEpisodeTitle] = useState('新集');
  const [newSceneTitle, setNewSceneTitle] = useState('新场');
  const [scopeId, setScopeId] = useState('production-root');
  const [editingTitle, setEditingTitle] = useState('');
  const [assemblyError, setAssemblyError] = useState('');
  const [assembling, setAssembling] = useState(false);
  const navigation = useMemo(() => buildProductionNavigation(entities), [entities]);
  const episodes = useMemo(() => entities.filter((entity) => entity.kind === 'episode').sort((left, right) => Number(left.payload.order ?? 0) - Number(right.payload.order ?? 0)), [entities]);
  const scenes = useMemo(() => entities.filter((entity) => entity.kind === 'scene').sort((left, right) => Number(left.payload.order ?? 0) - Number(right.payload.order ?? 0)), [entities]);
  const selectedEntity = entities.find((entity) => entity.id === scopeId && ['episode', 'scene'].includes(entity.kind));
  const visibleShotIds = useMemo(() => findNavigationNode(navigation, scopeId)?.shotIds ?? navigation.shotIds, [navigation, scopeId]);
  const visibleShots = useMemo(() => shots.filter((shot) => visibleShotIds.includes(shot.id)), [shots, visibleShotIds]);
  useEffect(() => {
    setEditingTitle(selectedEntity?.kind === 'scene' ? payloadText(selectedEntity, 'heading') : payloadText(selectedEntity ?? ({} as ProductionEntity), 'title'));
  }, [selectedEntity?.id, selectedEntity?.revision]);
  useEffect(() => {
    let active = true;
    const refreshCandidates = () => {
      if (projectId) void listAssets(projectId).then((items) => { if (active) setAssets(items); }).catch(() => { if (active) setAssets([]); });
      if (boardId) void listRuns(boardId).then((items) => { if (active) setRuns(items); }).catch(() => { if (active) setRuns([]); });
    };
    refreshCandidates();
    const timer = window.setInterval(refreshCandidates, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, boardId]);
  async function assemble() {
    if (!projectId || !boardId || !shots.length) return;
    const plan = buildEpisodeAssembly(projectId, boardId, `episode_${crypto.randomUUID()}`, episodeTitle.trim() || '新集', shots.map((shot) => {
      const selected = shot.payload.selected && typeof shot.payload.selected === 'object' ? shot.payload.selected as Record<string, unknown> : {};
      const video = selected.video && typeof selected.video === 'object' ? selected.video as Record<string, unknown> : {};
      const asset = assets.find((item) => item.id === video.assetId);
      return {
        id: shot.id,
        order: Number(shot.payload.order ?? 0),
        durationMs: Number(shot.payload.durationMs ?? 3000),
        selectedAssetId: typeof video.assetId === 'string' ? video.assetId : undefined,
        assetDurationTicks: asset?.duration === undefined ? undefined : Math.round(asset.duration * 240_000),
      };
    }));
    const blockingIssues = plan.issues.filter((item) => item.code !== 'SHOT_ASSET_SHORTER_THAN_SPEC');
    if (blockingIssues.length) {
      setAssemblyError(blockingIssues.map((item) => `${item.shotId}: ${item.code}`).join('、'));
      return;
    }
    if (plan.issues.some((item) => item.code === 'SHOT_ASSET_SHORTER_THAN_SPEC') && !window.confirm('部分候选短于镜头规格，确认按实际时长装配并保留调整记录吗？')) return;
    setAssembling(true); setAssemblyError('');
    try {
      await applyProductionChange(projectId, crypto.randomUUID(), { [plan.episode.id]: 0, [plan.timeline.id]: 0 }, [
        { id: plan.episode.id, kind: 'episode', op: 'assembleEpisode', payload: { ...plan.episode, boardId } },
        { id: plan.timeline.id, kind: 'timeline', payload: { ...plan.timeline, episodeId: plan.episode.id, boardId } },
      ]);
      window.dispatchEvent(new CustomEvent('production-timeline-created', { detail: { projectId, boardId, timelineId: plan.timeline.id } }));
      setAssemblyError(`已冻结 ${plan.episode.frozenShots.length} 个镜头并创建集时间线。`);
      onRefresh();
    } catch (reason) { setAssemblyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssembling(false); }
  }
  async function saveStructureEdit(entity: ProductionEntity, payload: Record<string, unknown>) {
    if (!projectId) return;
    setAssembling(true); setAssemblyError('');
    try {
      await applyProductionChange(projectId, crypto.randomUUID(), { [entity.id]: entity.revision }, [{ id: entity.id, kind: entity.kind, payload }]);
      await onRefresh();
    } catch (reason) { setAssemblyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssembling(false); }
  }
  async function createEpisode() {
    if (!projectId) return;
    const id = `episode_${crypto.randomUUID()}`;
    setAssembling(true); setAssemblyError('');
    try {
      await applyProductionChange(projectId, crypto.randomUUID(), { [id]: 0 }, [{ id, kind: 'episode', payload: { title: episodeTitle.trim() || `第 ${episodes.length + 1} 集`, order: episodes.length + 1, requiredShotIds: [], frozenShots: [] } }]);
      setScopeId(id);
      await onRefresh();
    } catch (reason) { setAssemblyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssembling(false); }
  }
  async function createScene() {
    if (!projectId || !episodes.some((episode) => episode.id === scopeId)) { setAssemblyError('请先在导航树选择一集，再新建场。'); return; }
    const siblings = scenes.filter((scene) => scene.payload.episodeId === scopeId);
    const id = `scene_${crypto.randomUUID()}`;
    setAssembling(true); setAssemblyError('');
    try {
      await applyProductionChange(projectId, crypto.randomUUID(), { [id]: 0 }, [{ id, kind: 'scene', payload: { episodeId: scopeId, heading: newSceneTitle.trim() || `场 ${siblings.length + 1}`, order: siblings.length + 1 } }]);
      setScopeId(id);
      await onRefresh();
    } catch (reason) { setAssemblyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssembling(false); }
  }
  async function reorderSelected(direction: 'up' | 'down') {
    const next = reorderStructureSiblings(entities, scopeId, direction);
    const changed = next.filter((entity) => entity.payload.order !== entities.find((item) => item.id === entity.id)?.payload.order);
    if (!projectId || !changed.length) return;
    setAssembling(true); setAssemblyError('');
    try {
      await applyProductionChange(projectId, crypto.randomUUID(), Object.fromEntries(changed.map((entity) => [entity.id, entity.revision])), changed.map((entity) => ({ id: entity.id, kind: entity.kind, payload: entity.payload })));
      await onRefresh();
    } catch (reason) { setAssemblyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssembling(false); }
  }
  return <section className="production-panel"><header><div><h2>镜头列表</h2><p>每个镜头独立显示规格、主体绑定、产物槽和审批状态。</p></div><div className="production-actions"><button className="studio-button" type="button" onClick={onAdd} disabled={busy}><Layers3 size={14} /> 新建镜头</button></div></header><div className="production-structure"><div className="production-structure-title"><ListTree size={14} /> 集 / 场 / 镜导航</div><NavigationTree node={navigation} selectedId={scopeId} onSelect={setScopeId} />{selectedEntity && <div className="production-structure-edit"><label>名称<input aria-label="集或场名称" value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} /></label><button type="button" disabled={assembling || !editingTitle.trim()} onClick={() => void saveStructureEdit(selectedEntity, renameStructureEntity(selectedEntity, editingTitle.trim()))}>保存名称</button><button type="button" aria-label="向上移动集场" disabled={assembling} onClick={() => void reorderSelected('up')}><ArrowUp size={13} /></button><button type="button" aria-label="向下移动集场" disabled={assembling} onClick={() => void reorderSelected('down')}><ArrowDown size={13} /></button></div>}<div className="production-structure-create"><button type="button" disabled={assembling} onClick={() => void createEpisode()}>新建集</button><label>场名称<input aria-label="新场名称" value={newSceneTitle} onChange={(event) => setNewSceneTitle(event.target.value)} /></label><button type="button" disabled={assembling || !episodes.some((episode) => episode.id === scopeId)} onClick={() => void createScene()}>在选中集中新建场</button></div></div><div className="episode-assembly-controls"><label>集名称<input aria-label="装配集名称" value={episodeTitle} onChange={(event) => setEpisodeTitle(event.target.value)} /></label><button type="button" className="studio-button secondary" onClick={() => void assemble()} disabled={assembling || busy || !shots.length}>冻结镜头并创建时间线</button>{assemblyError && <p role="status">{assemblyError}</p>}</div><div className="production-shot-list">{[...visibleShots].sort((a, b) => Number(a.payload.order ?? 0) - Number(b.payload.order ?? 0)).map((shot) => <ShotCard key={shot.id} shot={shot} projectId={projectId ?? String(shot.payload.projectId ?? '')} subjects={subjects} assets={assets} runs={runs} scenes={scenes} siblingShots={shots.filter((item) => item.id !== shot.id)} onRefresh={onRefresh} />)}{!visibleShots.length && <div className="production-empty">当前结构没有镜头。可从剧本拆镜草案应用，或先创建空镜头。</div>}</div></section>;
}

function findNavigationNode(node: ProductionNavigationNode, id: string): ProductionNavigationNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNavigationNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function NavigationTree({ node, selectedId, onSelect, depth = 0 }: { node: ProductionNavigationNode; selectedId: string; onSelect: (id: string) => void; depth?: number }) {
  return <div className="production-structure-node" style={{ marginLeft: depth * 12 }}><button type="button" className={selectedId === node.id ? 'active' : ''} onClick={() => onSelect(node.id)}><span>{node.kind === 'shot' ? '镜' : node.kind === 'scene' ? '场' : node.kind === 'episode' ? '集' : '·'}</span>{node.label}<small>{node.shotIds.length}</small></button>{node.children.map((child) => <NavigationTree key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />)}</div>;
}

function ShotCard({ shot, projectId, subjects, assets, runs, scenes, siblingShots, onRefresh }: { shot: ProductionEntity; projectId: string; subjects: ProductionEntity[]; assets: AssetRef[]; runs: RunRecord[]; scenes: ProductionEntity[]; siblingShots: ProductionEntity[]; onRefresh: () => void | Promise<void> }) {
  const [title, setTitle] = useState(payloadText(shot, 'title'));
  const [action, setAction] = useState(payloadText(shot, 'action'));
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<string>('');
  const [runningAction, setRunningAction] = useState<string>();
  const requestRun = useRunController((state) => state.requestRun);
  const board = useBoardStore((state) => state.board);
  const [candidateId, setCandidateId] = useState('');
  const [slot, setSlot] = useState<ShotSlot>('video');
  const executions = readShotExecutions(shot.payload);
  const existingBinding = Array.isArray(shot.payload.bindings) ? shot.payload.bindings[0] as Record<string, unknown> : undefined;
  const hasUnsavedSpecChanges = title !== payloadText(shot, 'title') || action !== payloadText(shot, 'action');
  const [subjectId, setSubjectId] = useState(typeof existingBinding?.subjectId === 'string' ? existingBinding.subjectId : '');
  const [subjectVersion, setSubjectVersion] = useState(Number(existingBinding?.version ?? 1));
  async function save() {
    setSaving(true);
    try { await applyProductionChange(projectId, crypto.randomUUID(), { [shot.id]: shot.revision }, [{ id: shot.id, kind: 'shot', op: 'setShotBindings', payload: { ...shot.payload, title, action, bindings: subjectId ? [{ bindingId: `${shot.id}:${subjectId}`, subjectId, version: subjectVersion }] : [] } }]); onRefresh(); }
    finally { setSaving(false); }
  }
  async function previewAction(actionName: string) {
    if (!projectId) return;
    const actionKey = actionName as ShotAction;
    const resolution = resolveShotExecutionNode({ board: board?.projectId === projectId ? board : undefined, executions, action: actionKey });
    if (!resolution.nodeId) {
      setPreview(resolution.message ?? `当前画板没有可用于「${SHOT_ACTION_LABELS[actionKey]}」的独立执行节点，请先添加或绑定。`);
      return;
    }
    setRunningAction(actionName);
    try {
      if (resolution.binding) {
        await applyProductionChange(projectId, crypto.randomUUID(), { [shot.id]: shot.revision }, [{ id: shot.id, kind: 'shot', op: 'upsertEntity', payload: withShotExecution(shot.payload, actionKey, resolution.binding.nodeId) }]);
        await onRefresh();
      }
      await requestRun(resolution.nodeId, { entityId: shot.id, action: actionName });
      setPreview(`${SHOT_ACTION_LABELS[actionKey]} 已提交到统一运行确认流程（执行节点 ${resolution.nodeId}）；成功结果仍需手动采用。`);
    }
    catch (reason) { setPreview(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRunningAction(undefined); }
  }
  async function approve() {
    if (!projectId) return;
    const selected = shot.payload.selected;
    const video = selected && typeof selected === 'object' ? (selected as Record<string, unknown>).video : undefined;
    if (!video || typeof video !== 'object' || typeof (video as Record<string, unknown>).adoptionId !== 'string') {
      setPreview('需先采用视频候选，才能审批当前镜头版本。');
      return;
    }
    const adoptionId = (video as Record<string, unknown>).adoptionId as string;
    const specHash = shotSpecHash(shot.payload);
    setSaving(true);
    setPreview('');
    try {
      let revision = shot.revision;
      for (const state of nextReviewStates(String(shot.payload.review ?? 'draft'))) {
        const result = await recordProductionReview(projectId, crypto.randomUUID(), { [shot.id]: revision }, shot.id, { state, specHash, adoptionId, decision: 'local-review' });
        revision = result.revisionMap[shot.id] ?? revision + 1;
      }
      setPreview('镜头已标记为审批通过。');
      onRefresh();
    } catch (reason) { setPreview(describeReviewError(reason)); }
    finally { setSaving(false); }
  }
  async function adopt() {
    if (!candidateId) return;
    setSaving(true);
    try { await adoptShotMedia(projectId, crypto.randomUUID(), { [shot.id]: shot.revision }, shot.id, slot, candidateId, shotSpecHash(shot.payload)); setCandidateId(''); onRefresh(); }
    catch (reason) { setPreview(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  async function moveToScene(sceneId: string) {
    const scene = scenes.find((item) => item.id === sceneId);
    setSaving(true);
    try {
      const payload = moveShotToScene(shot, scene, scene ? siblingShots.filter((item) => item.payload.sceneId === scene.id) : []);
      await applyProductionChange(projectId, crypto.randomUUID(), { [shot.id]: shot.revision }, [{ id: shot.id, kind: 'shot', payload }]);
      onRefresh();
    } catch (reason) { setPreview(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  const slotAssets = assets.filter((asset) => (SHOT_SLOT_ASSET_KINDS[slot] as readonly string[]).includes(asset.kind));
  const associatedAssets = new Set(runs.filter((run) => run.entityId === shot.id && run.status === 'succeeded').flatMap((run) => run.outputAssetIds));
  const selectedSlots = shot.payload.selected && typeof shot.payload.selected === 'object' ? shot.payload.selected as Record<string, unknown> : {};
  return <article className="production-shot-card"><header><div><span className="shot-order">#{String(shot.payload.order ?? '?')}</span><input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="镜头标题" /></div><span className={`production-status ${String(shot.payload.review ?? 'draft')}`}>{String(shot.payload.review ?? 'draft')}</span></header><label>所属场<select aria-label="镜头所属场" value={typeof shot.payload.sceneId === 'string' ? shot.payload.sceneId : ''} disabled={saving || !scenes.length} onChange={(event) => void moveToScene(event.target.value)}><option value="">未分场</option>{scenes.map((scene) => <option key={scene.id} value={scene.id}>{payloadText(scene, 'heading') || scene.id}</option>)}</select></label><label>动作<textarea value={action} onChange={(event) => setAction(event.target.value)} /></label><div className="shot-bindings"><label>主体<select aria-label="镜头主体" value={subjectId} onChange={(event) => { setSubjectId(event.target.value); setSubjectVersion(1); }}><option value="">未绑定</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{payloadText(subject, 'name') || subject.id}</option>)}</select></label>{subjectId && <label>版本<select aria-label="主体版本" value={subjectVersion} onChange={(event) => setSubjectVersion(Number(event.target.value))}>{Array.from({ length: Number(subjects.find((item) => item.id === subjectId)?.payload.currentVersion ?? 1) }, (_, index) => <option key={index + 1} value={index + 1}>v{index + 1}</option>)}</select></label>}</div><div className="shot-action-grid">{SHOT_ACTIONS.map((actionName) => <button key={actionName} type="button" onClick={() => void previewAction(actionName)} disabled={Boolean(runningAction)}>{runningAction === actionName ? '预览中…' : SHOT_ACTION_LABELS[actionName]}</button>)}</div><div className="shot-adoption"><select aria-label="产物槽位" value={slot} disabled={saving} onChange={(event) => { setSlot(event.currentTarget.value as ShotSlot); setCandidateId(''); }}>{SHOT_SLOTS.map((item) => <option key={item} value={item}>{SHOT_SLOT_LABELS[item]}槽</option>)}</select><select aria-label="选择候选素材" value={candidateId} onChange={(event) => setCandidateId(event.currentTarget.value)}><option value="">选择{SHOT_SLOT_LABELS[slot]}候选</option>{slotAssets.map((asset) => <option key={asset.id} value={asset.id}>{associatedAssets.has(asset.id) ? '本镜头运行 · ' : ''}{asset.provenance.displayName ?? asset.id}</option>)}</select><button type="button" onClick={() => void adopt()} disabled={saving || hasUnsavedSpecChanges || !candidateId}>采用到{SHOT_SLOT_LABELS[slot]}槽</button></div>{hasUnsavedSpecChanges && <p className="shot-preview-status" role="status">请先保存规格，再采用候选或审批。</p>}{preview && <p className="shot-preview-status" role="status">{preview}</p>}<footer><span>{SHOT_SLOT_LABELS[slot]}：{selectedSlots[slot] ? '已有候选' : '未采用'}</span><div><button type="button" onClick={() => void save()} disabled={saving}>保存镜头</button><button type="button" onClick={() => void approve()} disabled={saving || hasUnsavedSpecChanges}>标记审批</button></div></footer></article>;
}
