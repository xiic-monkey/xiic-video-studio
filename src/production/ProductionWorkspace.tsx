import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, BookOpen, Layers3, ListTree, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { applyProductionChange, importScriptDocument, listAssets, listProductionEntityPage, listRuns, pickScriptFile, type ProductionEntity } from '../services/tauri';
import { buildEpisodeAssembly } from '../domain/production/assembly';
import { buildProductionNavigation } from '../domain/production/navigation';
import { renameStructureEntity, reorderStructureSiblings } from '../domain/production/navigationEdits';
import { confirmAction } from '../ui/confirmStore';
import { ScriptPanel } from './panels/ScriptPanel';
import { SubjectLibrary } from './panels/SubjectLibrary';
import { ShotCard } from './panels/ShotCard';
import { findNavigationNode, NavigationTree } from './panels/NavigationTree';
import { payloadText } from './panels/payloadText';
import type { AssetRef, RunRecord } from '../domain/types';

type WorkspaceTab = 'script' | 'subjects' | 'shots';

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

  /**
   * 删除制作实体。
   *
   * 后端是软删除（标记归档），但界面上仍按不可逆处理：确认框会说明连带影响，
   * 例如删场会清掉该场下的镜头。
   */
  async function deleteEntity(entity: ProductionEntity) {
    if (!projectId) return;
    const label = payloadText(entity, 'title') || payloadText(entity, 'name') || payloadText(entity, 'heading') || entity.id;
    const kindLabel = { script: '剧本', subject: '主体', shot: '镜头', episode: '集', scene: '场' }[entity.kind] ?? entity.kind;
    // 级联范围：删场要带走场里的镜头；删集要带走集里的场与镜头。
    // 否则会留下指向空父级的孤儿实体。
    const cascadeScenes = entity.kind === 'episode'
      ? entities.filter((item) => item.kind === 'scene' && item.payload.episodeId === entity.id)
      : [];
    const cascadeShots = entity.kind === 'scene'
      ? shots.filter((shot) => shot.payload.sceneId === entity.id)
      : entity.kind === 'episode'
        ? shots.filter((shot) => shot.payload.episodeId === entity.id || cascadeScenes.some((scene) => scene.id === shot.payload.sceneId))
        : [];
    const affected = cascadeShots.length;
    const confirmed = await confirmAction({
      title: `删除${kindLabel}`,
      message: `确定删除${kindLabel}「${label}」？`,
      detail: affected || cascadeScenes.length
        ? `该${kindLabel}下有 ${cascadeScenes.length} 个场、${affected} 个镜头，删除后它们也会一并移除。此操作不可撤销。`
        : '删除后无法撤销，只能从变更记录里追溯。',
      tone: 'danger',
      confirmText: `删除${kindLabel}`,
    });
    if (!confirmed) return;
    setBusy(true); setError('');
    try {
      const operations = [{ id: entity.id, kind: entity.kind, op: 'deleteEntity', payload: {} }];
      const expectedRevisions: Record<string, number> = { [entity.id]: entity.revision };
      for (const scene of cascadeScenes) {
        operations.push({ id: scene.id, kind: 'scene', op: 'deleteEntity', payload: {} });
        expectedRevisions[scene.id] = scene.revision;
      }
      for (const shot of cascadeShots) {
        operations.push({ id: shot.id, kind: 'shot', op: 'deleteEntity', payload: {} });
        expectedRevisions[shot.id] = shot.revision;
      }
      await applyProductionChange(projectId, crypto.randomUUID(), expectedRevisions, operations);
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
        <div><span className="studio-eyebrow">制作</span><h1>剧本与镜头</h1><p>项目级实体与画布共用同一修订、素材和审批记录。</p></div>
        <button type="button" className="studio-icon-button" title="刷新制作数据" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} /></button>
      </header>
      <nav className="production-tabs" aria-label="制作视图">
        <button type="button" className={tab === 'script' ? 'active' : ''} onClick={() => setTab('script')}><BookOpen size={14} /> 剧本</button>
        <button type="button" className={tab === 'subjects' ? 'active' : ''} onClick={() => setTab('subjects')}><UserRound size={14} /> 主体 ({subjects.length})</button>
        <button type="button" className={tab === 'shots' ? 'active' : ''} onClick={() => setTab('shots')}><Layers3 size={14} /> 镜头 ({shots.length})</button>
      </nav>
  {/* 三个面板始终挂载，只切换显隐：切走再切回来时，剧本草稿与
      本地拆镜草案都还在，不会因为卸载组件而丢失。 */}
  <div hidden={tab !== 'script'}>
    <ScriptPanel projectId={projectId} scripts={scripts} shots={shots} busy={busy} onImport={() => void importScript()} onRefresh={refresh} onDelete={(entity) => void deleteEntity(entity)} />
  </div>
  <div hidden={tab !== 'subjects'}>
    <SubjectLibrary projectId={projectId} subjects={subjects} busy={busy} onAdd={(name, kind, descriptor) => void addSubject(name, kind, descriptor)} onRefresh={() => void refresh()} onDelete={(entity) => void deleteEntity(entity)} />
  </div>
  <div hidden={tab !== 'shots'}>
    <ShotList projectId={projectId} boardId={boardId} entities={entities} shots={shots} subjects={subjects} busy={busy} onAdd={() => void addShot()} onRefresh={() => void refresh()} onDelete={(entity) => void deleteEntity(entity)} />
  </div>
      {error && <p className="production-error" role="alert">{error}</p>}
    </div>
  );
}

function ShotList({ projectId, boardId, entities, shots, subjects, busy, onAdd, onRefresh, onDelete }: { projectId?: string; boardId?: string; entities: ProductionEntity[]; shots: ProductionEntity[]; subjects: ProductionEntity[]; busy: boolean; onAdd: () => void; onRefresh: () => void; onDelete: (entity: ProductionEntity) => void }) {
  const [assets, setAssets] = useState<AssetRef[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [episodeTitle, setEpisodeTitle] = useState('新集');
  const [newSceneTitle, setNewSceneTitle] = useState('新场');
  const [scopeId, setScopeId] = useState('production-root');
  const [editingTitle, setEditingTitle] = useState('');
  const [assemblyError, setAssemblyError] = useState('');
  // 成功提示与错误分开存：以前成功信息塞在 error 变量里，界面只能按错误样式渲染。
  const [assemblyNotice, setAssemblyNotice] = useState('');
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
    // 后台不轮询：窗口不可见时没必要持续请求。
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      refreshCandidates();
    }, 5000);
    const onVisibility = () => { if (!document.hidden) refreshCandidates(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
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
    if (plan.issues.some((item) => item.code === 'SHOT_ASSET_SHORTER_THAN_SPEC')) {
      const confirmed = await confirmAction({
        title: '按实际时长装配',
        message: '部分候选短于镜头规格。',
        detail: '确认后会按素材实际时长装配，并在集时间线里保留调整记录。',
        confirmText: '确认装配',
      });
      if (!confirmed) return;
    }
    setAssembling(true); setAssemblyError(''); setAssemblyNotice('');
    try {
      await applyProductionChange(projectId, crypto.randomUUID(), { [plan.episode.id]: 0, [plan.timeline.id]: 0 }, [
        { id: plan.episode.id, kind: 'episode', op: 'assembleEpisode', payload: { ...plan.episode, boardId } },
        { id: plan.timeline.id, kind: 'timeline', payload: { ...plan.timeline, episodeId: plan.episode.id, boardId } },
      ]);
      window.dispatchEvent(new CustomEvent('production-timeline-created', { detail: { projectId, boardId, timelineId: plan.timeline.id } }));
      setAssemblyError('');
      setAssemblyNotice(`已冻结 ${plan.episode.frozenShots.length} 个镜头并创建集时间线。`);
      onRefresh();
    } catch (reason) { setAssemblyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssembling(false); }
  }
  async function saveStructureEdit(entity: ProductionEntity, payload: Record<string, unknown>) {
    if (!projectId) return;
    setAssembling(true); setAssemblyError(''); setAssemblyNotice('');
    try {
      await applyProductionChange(projectId, crypto.randomUUID(), { [entity.id]: entity.revision }, [{ id: entity.id, kind: entity.kind, payload }]);
      await onRefresh();
    } catch (reason) { setAssemblyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssembling(false); }
  }
  async function createEpisode() {
    if (!projectId) return;
    const id = `episode_${crypto.randomUUID()}`;
    setAssembling(true); setAssemblyError(''); setAssemblyNotice('');
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
    setAssembling(true); setAssemblyError(''); setAssemblyNotice('');
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
    setAssembling(true); setAssemblyError(''); setAssemblyNotice('');
    try {
      await applyProductionChange(projectId, crypto.randomUUID(), Object.fromEntries(changed.map((entity) => [entity.id, entity.revision])), changed.map((entity) => ({ id: entity.id, kind: entity.kind, payload: entity.payload })));
      await onRefresh();
    } catch (reason) { setAssemblyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssembling(false); }
  }
  return <section className="production-panel"><header><div><h2>镜头列表</h2><p>每个镜头独立显示规格、主体绑定、产物槽和审批状态。</p></div><div className="production-actions"><button className="studio-button" type="button" onClick={onAdd} disabled={busy}><Layers3 size={14} /> 新建镜头</button></div></header><div className="production-structure"><div className="production-structure-title"><ListTree size={14} /> 集 / 场 / 镜导航</div><NavigationTree node={navigation} selectedId={scopeId} onSelect={setScopeId} />{selectedEntity && <div className="production-structure-edit"><label>名称<input aria-label="集或场名称" value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} /></label><button type="button" disabled={assembling || !editingTitle.trim()} onClick={() => void saveStructureEdit(selectedEntity, renameStructureEntity(selectedEntity, editingTitle.trim()))}>保存名称</button><button type="button" aria-label="向上移动集场" disabled={assembling} onClick={() => void reorderSelected('up')}><ArrowUp size={13} /></button><button type="button" aria-label="向下移动集场" disabled={assembling} onClick={() => void reorderSelected('down')}><ArrowDown size={13} /></button></div>}<div className="production-structure-create"><button type="button" disabled={assembling} onClick={() => void createEpisode()}>新建集</button><label>场名称<input aria-label="新场名称" value={newSceneTitle} onChange={(event) => setNewSceneTitle(event.target.value)} /></label><button type="button" disabled={assembling || !episodes.some((episode) => episode.id === scopeId)} onClick={() => void createScene()}>在选中集中新建场</button></div></div><div className="episode-assembly-controls"><label>集名称<input aria-label="装配集名称" value={episodeTitle} onChange={(event) => setEpisodeTitle(event.target.value)} /></label><button type="button" className="studio-button secondary" onClick={() => void assemble()} disabled={assembling || busy || !shots.length}>冻结镜头并创建时间线</button>{assemblyError && <p className="production-error" role="alert">{assemblyError}</p>}
      {assemblyNotice && <p className="shot-preview-status" role="status">{assemblyNotice}</p>}</div><div className="production-shot-list">{[...visibleShots].sort((a, b) => Number(a.payload.order ?? 0) - Number(b.payload.order ?? 0)).map((shot) => <ShotCard key={shot.id} shot={shot} projectId={projectId ?? String(shot.payload.projectId ?? '')} subjects={subjects} assets={assets} runs={runs} scenes={scenes} siblingShots={shots.filter((item) => item.id !== shot.id)} onRefresh={onRefresh} onDelete={onDelete} />)}{!visibleShots.length && <div className="production-empty">当前结构没有镜头。可从剧本拆镜草案应用，或先创建空镜头。</div>}</div></section>;
}
