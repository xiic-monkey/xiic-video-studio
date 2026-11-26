import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { adoptShotMedia, applyProductionChange, recordProductionReview, type ProductionEntity } from '../../services/tauri';
import { shotSpecHash } from '../../domain/production/shots';
import { moveShotToScene } from '../../domain/production/navigationEdits';
import { reviewLabel } from '../../domain/production/labels';
import { useRunController } from '../../run/controller';
import { useBoardStore } from '../../stores/boardStore';
import { readShotExecutions, resolveShotExecutionNode, SHOT_ACTIONS, SHOT_ACTION_LABELS, SHOT_SLOT_ASSET_KINDS, SHOT_SLOT_LABELS, SHOT_SLOTS, withShotExecution, type ShotAction, type ShotSlot } from '../shotExecution';
import { describeReviewError, nextReviewStates } from '../shotReview';
import type { AssetRef, RunRecord } from '../../domain/types';
import { payloadText } from './payloadText';

export function ShotCard({ shot, projectId, subjects, assets, runs, scenes, siblingShots, onRefresh, onDelete }: { shot: ProductionEntity; projectId: string; subjects: ProductionEntity[]; assets: AssetRef[]; runs: RunRecord[]; scenes: ProductionEntity[]; siblingShots: ProductionEntity[]; onRefresh: () => void | Promise<void>; onDelete: (entity: ProductionEntity) => void }) {
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
    catch (reason) { setPreview(reason instanceof Error ? reason.message : String(reason)); }
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
  return <article className="production-shot-card"><header><div><span className="shot-order">#{String(shot.payload.order ?? '?')}</span><input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="镜头标题" /></div><span className={`production-status ${String(shot.payload.review ?? 'draft')}`}>{reviewLabel(shot.payload.review)}</span><button type="button" className="production-item-remove" title="删除镜头" aria-label={`删除镜头 ${title}`} onClick={() => { void onDelete(shot); }}><Trash2 size={12} /></button></header><label>所属场<select aria-label="镜头所属场" value={typeof shot.payload.sceneId === 'string' ? shot.payload.sceneId : ''} disabled={saving || !scenes.length} onChange={(event) => void moveToScene(event.target.value)}><option value="">未分场</option>{scenes.map((scene) => <option key={scene.id} value={scene.id}>{payloadText(scene, 'heading') || scene.id}</option>)}</select></label><label>动作<textarea value={action} onChange={(event) => setAction(event.target.value)} /></label><div className="shot-bindings"><label>主体<select aria-label="镜头主体" value={subjectId} onChange={(event) => { setSubjectId(event.target.value); setSubjectVersion(1); }}><option value="">未绑定</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{payloadText(subject, 'name') || subject.id}</option>)}</select></label>{subjectId && <label>版本<select aria-label="主体版本" value={subjectVersion} onChange={(event) => setSubjectVersion(Number(event.target.value))}>{Array.from({ length: Number(subjects.find((item) => item.id === subjectId)?.payload.currentVersion ?? 1) }, (_, index) => <option key={index + 1} value={index + 1}>v{index + 1}</option>)}</select></label>}</div><div className="shot-action-grid">{SHOT_ACTIONS.map((actionName) => <button key={actionName} type="button" onClick={() => void previewAction(actionName)} disabled={Boolean(runningAction)}>{runningAction === actionName ? '预览中…' : SHOT_ACTION_LABELS[actionName]}</button>)}</div><div className="shot-adoption"><select aria-label="产物槽位" value={slot} disabled={saving} onChange={(event) => { setSlot(event.currentTarget.value as ShotSlot); setCandidateId(''); }}>{SHOT_SLOTS.map((item) => <option key={item} value={item}>{SHOT_SLOT_LABELS[item]}槽</option>)}</select><select aria-label="选择候选素材" value={candidateId} onChange={(event) => setCandidateId(event.currentTarget.value)}><option value="">选择{SHOT_SLOT_LABELS[slot]}候选</option>{slotAssets.map((asset) => <option key={asset.id} value={asset.id}>{associatedAssets.has(asset.id) ? '本镜头运行 · ' : ''}{asset.provenance.displayName ?? asset.id}</option>)}</select><button type="button" onClick={() => void adopt()} disabled={saving || hasUnsavedSpecChanges || !candidateId}>采用到{SHOT_SLOT_LABELS[slot]}槽</button></div>{hasUnsavedSpecChanges && <p className="shot-preview-status" role="status">请先保存规格，再采用候选或审批。</p>}{preview && <p className="shot-preview-status" role="status">{preview}</p>}<footer><span>{SHOT_SLOT_LABELS[slot]}：{selectedSlots[slot] ? '已有候选' : '未采用'}</span><div><button type="button" onClick={() => void save()} disabled={saving}>保存镜头</button><button type="button" onClick={() => void approve()} disabled={saving || hasUnsavedSpecChanges}>标记审批</button></div></footer></article>;
}

