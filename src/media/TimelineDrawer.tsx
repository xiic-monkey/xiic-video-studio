import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Captions, Film, Music2, Plus, Scissors, Trash2 } from 'lucide-react';
import { assetUrl, commitTimelineEdit, createLocalComposeEntity, importSubtitleDocument, listAssets, listMediaTasks, listProductionEntityPage, pickExportTarget, pickSubtitleFile, prepareMediaExport, replaceTimelineClip, startMediaExport, type MediaTask } from '../services/tauri';
import { applyTimelineEdit, formatSrt, parseSrt, previewClipReplacement, removeAudioTrack, TICKS_PER_SECOND, updateAudioTrack, type TimelineAudioTrack, type TimelineData, type TimelineEdit } from '../domain/media/timeline';
import { describeSaveError as describeSaveErrorText } from '../domain/saveError';
import { ActionSelect } from '../ui/ActionSelect';
import { confirmAction } from '../ui/confirmStore';
import { createLocalCompose } from './timelineController';
import { buildProbedAssets, formatTimelineSeconds, resolveTimelineNumberDraft, timelineNumberDraftKey, validateTimelineForSave } from './timelineEditing';
import type { AssetRef } from '../domain/types';

function seconds(ticks: number): string {
  return formatTimelineSeconds(ticks);
}

function describeSaveError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return `保存失败：${describeSaveErrorText(message, '时间线', '请刷新后重试。')}`;
}

export function TimelineDrawer({ projectId, boardId }: { projectId?: string; boardId?: string }) {
  const [assets, setAssets] = useState<AssetRef[]>([]);
  const [timeline, setTimeline] = useState<TimelineData>();
  const [preferredTimelineId, setPreferredTimelineId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [playerUrl, setPlayerUrl] = useState('');
  const [cueText, setCueText] = useState('');
  const [exportTasks, setExportTasks] = useState<MediaTask[]>([]);
  const [audioGainDraft, setAudioGainDraft] = useState<Record<string, number>>({});
  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>({});

  // 时间线写入必须串行：数字输入框连续失焦时，后一次提交要在前一次落库后、
  // 基于最新的 timeline 与 revision 计算，否则会用旧修订冲突或覆盖前一次改动。
  // ref 始终是「已提交状态」的唯一真相，state 仅用于渲染。
  const timelineRef = useRef<TimelineData | undefined>(undefined);
  const revisionRef = useRef(0);
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = writeChain.current.then(task, task);
    writeChain.current = run.then(() => undefined, () => undefined);
    return run;
  }
  function setLoaded(next: TimelineData | undefined, rev: number) {
    timelineRef.current = next;
    revisionRef.current = rev;
    setTimeline(next);
    setRevision(rev);
  }

  useEffect(() => {
    let active = true;
    if (!projectId) { setAssets([]); setTimeline(undefined); return; }
    void Promise.all([listAssets(projectId), listProductionEntityPage(projectId, 'timeline')]).then(([projectAssets, entities]) => {
      if (!active) return;
      setAssets(projectAssets);
      const existing = entities.find((entity) => entity.id === preferredTimelineId)
        ?? entities.find((entity) => entity.id === `${projectId}:${boardId}:compose`)
        ?? entities.find((entity) => entity.payload.boardId === boardId && entity.payload.assemblyScope === 'episode');
      if (existing) {
        setLoaded(existing.payload as unknown as TimelineData, existing.revision);
        setCueText(formatSrt(((existing.payload as unknown as TimelineData).subtitleCues ?? [])));
      } else {
        setLoaded(undefined, 0);
      }
    }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [projectId, boardId, preferredTimelineId]);

  useEffect(() => {
    const onCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; boardId: string; timelineId: string }>).detail;
      if (detail?.projectId === projectId && detail.boardId === boardId) setPreferredTimelineId(detail.timelineId);
    };
    window.addEventListener('production-timeline-created', onCreated);
    return () => window.removeEventListener('production-timeline-created', onCreated);
  }, [projectId, boardId]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const refreshTasks = () => void listMediaTasks(projectId).then((tasks) => {
      if (active) setExportTasks(tasks.filter((task) => task.kind === 'export').slice(0, 5));
    }).catch(() => undefined);
    refreshTasks();
    // 窗口在后台时停止轮询：看不见的时候没必要持续请求。
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      refreshTasks();
    }, 2500);
    const onVisibility = () => { if (!document.hidden) refreshTasks(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [projectId]);

  const videoAssets = useMemo(() => assets.filter((asset) => asset.kind === 'video'), [assets]);
  const probedAssets = useMemo(() => buildProbedAssets(assets), [assets]);
  const timelineIssues = useMemo(() => timeline ? validateTimelineForSave(timeline, probedAssets) : { errors: [], warnings: [] }, [timeline, probedAssets]);

  function clearNumberDraft(key: string) {
    setNumberDrafts((draft) => {
      if (draft[key] === undefined) return draft;
      const next = { ...draft };
      delete next[key];
      return next;
    });
  }

  /** 提交一次编辑：在串行队列里基于最新 timeline/revision 计算并落库。 */
  function save(mutate: (current: TimelineData) => TimelineData): Promise<boolean> {
    let ok = false;
    const task = async () => {
      const current = timelineRef.current;
      if (!projectId || !current) return;
      const next = mutate(current);
      const validation = validateTimelineForSave(next, probedAssets);
      if (validation.errors.length) {
        setError(`时间线有 ${validation.errors.length} 个问题，未保存：${validation.errors.join('、')}`);
        setSaved('');
        return;
      }
      setBusy(true); setError(''); setSaved('');
      try {
        const result = await commitTimelineEdit(projectId, next.id, revisionRef.current, next as unknown as Record<string, unknown>);
        setLoaded(next, result.revisionMap[next.id] ?? revisionRef.current + 1);
        setSaved('已保存');
        if (validation.warnings.length) setError(`已保存，但有提示：${validation.warnings.join('、')}`);
        ok = true;
      } catch (reason) {
        setError(describeSaveError(reason));
      } finally { setBusy(false); }
    };
    return enqueue(task).then(() => ok);
  }

  function apply(edit: TimelineEdit): Promise<boolean> {
    return save((current) => applyTimelineEdit(current, edit));
  }

  /** 数字输入框：本地草稿受控，失焦提交；未修改不提交，失败保留草稿。 */
  async function commitNumber(key: string, rawValue: string, originalTicks: number, submit: (nextTicks: number) => Promise<boolean>, label: string) {
    const resolution = resolveTimelineNumberDraft(rawValue, originalTicks);
    if (!resolution.valid) { setError(`${label}必须是非负数字`); return; }
    if (!resolution.changed) { clearNumberDraft(key); return; }
    const ok = await submit(resolution.ticks);
    if (ok) clearNumberDraft(key);
  }

  async function replaceClip(clipId: string, assetId: string, sourceInTicks: number, sourceOutTicks: number, acknowledgeShorter: boolean) {
    if (!projectId) return;
    await enqueue(async () => {
      const current = timelineRef.current;
      if (!current) return;
      setBusy(true); setError('');
      try {
        const result = await replaceTimelineClip(projectId, current.id, revisionRef.current, clipId, assetId, sourceInTicks, sourceOutTicks, acknowledgeShorter);
        const next = { ...current, clips: current.clips.map((clip) => clip.id === clipId ? { ...clip, assetId, sourceInTicks, sourceOutTicks } : clip), revision: current.revision + 1 };
        setLoaded(next, result.revisionMap[current.id] ?? revisionRef.current + 1);
        setSaved('已替换镜头素材');
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setBusy(false); }
    });
  }

  /** 用指定素材替换片段：新素材短于原片段时要先确认裁切。 */
  async function replaceClipWithAsset(clip: TimelineData['clips'][number], assetId: string) {
    const replacement = assets.find((item) => item.id === assetId);
    if (!replacement) return;
    const durationTicks = Math.round((replacement.duration ?? 0) * TICKS_PER_SECOND);
    const preview = previewClipReplacement(clip, durationTicks);
    if (!preview.hasValidRange) { setError('新素材短于当前入点，无法保留有效片段'); return; }
    if (preview.requiresConfirmation) {
      const confirmed = await confirmAction({
        title: '替换片段素材',
        message: `新素材会少 ${seconds(preview.lostTicks)} 秒。`,
        detail: '替换后会自动裁切到原片段长度，无法恢复。',
        tone: 'danger',
        confirmText: '替换并裁切',
      });
      if (!confirmed) return;
    }
    await replaceClip(clip.id, replacement.id, preview.sourceInTicks, preview.sourceOutTicks, preview.requiresConfirmation);
  }

  async function createCompose() {
    if (!projectId || !boardId || !selected.length) return;
    setBusy(true); setError('');
    try {
      const next = createLocalCompose(projectId, boardId, selected.map((id) => assets.find((asset) => asset.id === id)!).map((asset) => ({ id: asset.id, duration: asset.duration })));
      const validation = validateTimelineForSave(next, probedAssets);
      if (validation.errors.length) { setError(`合成时间线有问题，未创建：${validation.errors.join('、')}`); return; }
      const result = await createLocalComposeEntity(projectId, boardId, next as unknown as Record<string, unknown>);
      setLoaded(next, result.revisionMap[next.id] ?? 1); setCueText(''); setSaved('合成时间线已创建');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function importSrt() {
    if (!projectId) return;
    try {
      const grant = await pickSubtitleFile(projectId);
      if (!grant) return;
      const document = await importSubtitleDocument(projectId, grant.id);
      const cues = parseSrt(document.text);
      setCueText(formatSrt(cues));
      await save((current) => ({ ...current, subtitleCues: cues, revision: current.revision + 1 }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function preview(assetId: string) {
    if (!projectId) return;
    try { setPlayerUrl(await assetUrl(projectId, assetId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function saveCues() {
    try { await save((current) => ({ ...current, subtitleCues: parseSrt(cueText), revision: current.revision + 1 })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function exportNow() {
    const current = timelineRef.current;
    if (!projectId || !current || busy) return;
    setBusy(true); setError('');
    try {
      const preview = await prepareMediaExport(projectId, current.id, revisionRef.current);
      if (preview.issues.length) throw new Error(`导出预检未通过：${preview.issues.join('、')}`);
      // 阻断级问题必须先修好；必须明确确认级的问题逐条列出来，
      // 用户确认后才继续交付（设计 §9.3）。
      const warnings = preview.warnings ?? [];
      const target = await pickExportTarget(projectId);
      if (!target) return;
      const warningNote = warnings.length
        ? `\n\n需要明确确认的提示：\n${warnings.map((warning) => `· ${warning}`).join('\n')}\n\n确认后继续导出？`
        : '';
      const confirmed = await confirmAction({
        title: '导出 MP4',
        message: `导出 ${seconds(preview.totalTicks)} 秒视频到“${target.displayName}”？`,
        detail: warningNote,
        confirmText: '确认导出',
      });
      if (!confirmed) return;
      const task = await startMediaExport(preview.previewId, warnings, crypto.randomUUID(), target.id);
      setExportTasks((items) => [task, ...items.filter((item) => item.id !== task.id)].slice(0, 5));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return (
    <section className="timeline-drawer" aria-label="时间线">
      <header className="timeline-head">
        <div><b>时间线</b><span>{timeline ? `${timeline.clips.length} 个片段 · 修订 ${revision}` : '本地素材合成'}</span></div>
        <div className="timeline-actions">
          {timeline && <button type="button" onClick={importSrt} disabled={busy}><Captions size={14} /> 导入 SRT</button>}
          {!timeline && <button type="button" onClick={() => void createCompose()} disabled={!selected.length || busy}><Plus size={14} /> 创建合成 ({selected.length})</button>}
          {timeline && <button type="button" onClick={() => void exportNow()} disabled={busy || !timeline.clips.length}><Film size={14} /> 导出 MP4</button>}
          {saved && <span role="status">{saved}</span>}
        </div>
      </header>
      {!timeline ? (
        <div className="timeline-asset-picker">
          {videoAssets.map((asset) => (
            <label key={asset.id}>
              <input type="checkbox" checked={selected.includes(asset.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id))} />
              <Film size={14} /><span>{asset.provenance.displayName ?? asset.id.slice(0, 10)}</span><small>{asset.duration ? `${asset.duration.toFixed(1)} 秒` : '时长未知'}</small>
            </label>
          ))}
          {!videoAssets.length && <span>先导入本地视频素材</span>}
          {videoAssets.length > 0 && <p>勾选顺序决定初始片段顺序</p>}
        </div>
      ) : (
        <div className="timeline-content">
          <div className="timeline-track">
            {timeline.clips.map((clip, index) => {
              const asset = assets.find((item) => item.id === clip.assetId);
              const inKey = timelineNumberDraftKey('clip', clip.id, 'sourceIn');
              const outKey = timelineNumberDraftKey('clip', clip.id, 'sourceOut');
              return (
                <article key={clip.id} className="timeline-clip">
                  <header><b>{index + 1}. {asset?.provenance.displayName ?? clip.assetId.slice(0, 10)}</b><span>{seconds(clip.sourceOutTicks - clip.sourceInTicks)} 秒</span></header>
                  <div className="timeline-clip-controls">
                    <div className="timeline-clip-times">
                    <label>入点<input aria-label={`片段 ${index + 1} 入点`} type="number" min="0" step="0.001" value={numberDrafts[inKey] ?? seconds(clip.sourceInTicks)} onChange={(event) => setNumberDrafts((draft) => ({ ...draft, [inKey]: event.currentTarget.value }))} onBlur={(event) => void commitNumber(inKey, event.currentTarget.value, clip.sourceInTicks, (nextTicks) => apply({ type: 'trim', clipId: clip.id, sourceInTicks: nextTicks }), `片段 ${index + 1} 入点`)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
                    <label>出点<input aria-label={`片段 ${index + 1} 出点`} type="number" min="0" step="0.001" value={numberDrafts[outKey] ?? seconds(clip.sourceOutTicks)} onChange={(event) => setNumberDrafts((draft) => ({ ...draft, [outKey]: event.currentTarget.value }))} onBlur={(event) => void commitNumber(outKey, event.currentTarget.value, clip.sourceOutTicks, (nextTicks) => apply({ type: 'trim', clipId: clip.id, sourceOutTicks: nextTicks }), `片段 ${index + 1} 出点`)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
                    </div>
                    <div className="timeline-clip-actions">
                    <button type="button" title="向前排序" aria-label="向前排序" disabled={!index || busy} onClick={() => void apply({ type: 'reorder', clipId: clip.id, toIndex: index - 1 })}><ArrowUp size={13} /></button>
                    <button type="button" title="向后排序" aria-label="向后排序" disabled={index === timeline.clips.length - 1 || busy} onClick={() => void apply({ type: 'reorder', clipId: clip.id, toIndex: index + 1 })}><ArrowDown size={13} /></button>
                    <button type="button" title="拆分片段" aria-label="拆分片段" disabled={busy || clip.sourceOutTicks - clip.sourceInTicks < 16_000} onClick={() => {
                      const midpoint = clip.sourceInTicks + Math.floor((clip.sourceOutTicks - clip.sourceInTicks) / 2 / 8_000) * 8_000;
                      const first = { ...clip, sourceOutTicks: midpoint };
                      const second = { ...clip, id: `${clip.id}_split_${Date.now()}`, sourceInTicks: midpoint };
                      void save((current) => {
                        const at = current.clips.findIndex((item) => item.id === clip.id);
                        if (at < 0) return current;
                        return { ...current, clips: [...current.clips.slice(0, at), first, second, ...current.clips.slice(at + 1)], revision: current.revision + 1 };
                      });
                    }}><Scissors size={13} /></button>
                    <button type="button" title="删除片段" aria-label="删除片段" disabled={busy} onClick={() => void save((current) => ({ ...current, clips: current.clips.filter((item) => item.id !== clip.id), revision: current.revision + 1 }))}><Trash2 size={13} /></button>
                    <label>替换素材<ActionSelect
                      label={`替换片段 ${index + 1} 素材`}
                      placeholder="选择视频"
                      disabled={busy}
                      options={videoAssets.filter((item) => item.id !== clip.assetId).map((item) => ({ value: item.id, label: item.provenance.displayName ?? item.id }))}
                      onPick={(value) => { void replaceClipWithAsset(clip, value); }}
                    /></label>
                    {asset && <button type="button" onClick={() => void preview(asset.id)}>预览</button>}
                    </div>
                  </div>
                </article>
              );
            })}
            <label className="timeline-add-clip"><Plus size={14} /> 添加视频<ActionSelect
              label="添加视频片段"
              placeholder="选择视频"
              disabled={busy}
              options={videoAssets.map((asset) => ({ value: asset.id, label: asset.provenance.displayName ?? asset.id }))}
              onPick={(assetId) => {
                const asset = assets.find((item) => item.id === assetId);
                if (!asset) return;
                const clip = { id: `clip_${crypto.randomUUID()}`, assetId: asset.id, sourceInTicks: 0, sourceOutTicks: Math.round((asset.duration ?? 0) * TICKS_PER_SECOND) };
                void save((current) => ({ ...current, clips: [...current.clips, clip], revision: current.revision + 1 }));
              }}
            /></label>
            <label className="timeline-add-clip"><Music2 size={14} /> 添加音轨<ActionSelect
              label="添加音频轨道"
              placeholder="选择音频"
              disabled={busy}
              options={assets.filter((asset) => asset.kind === 'audio').map((asset) => ({ value: asset.id, label: asset.provenance.displayName ?? asset.id }))}
              onPick={(assetId) => {
                const asset = assets.find((item) => item.id === assetId);
                if (!asset) return;
                const audioTrack = { id: `audio_${crypto.randomUUID()}`, assetId: asset.id, sourceInTicks: 0, sourceOutTicks: Math.round((asset.duration ?? 0) * TICKS_PER_SECOND), timelineInTicks: 0, gain: 1 };
                void save((current) => ({ ...current, audioTracks: [...(current.audioTracks ?? []), audioTrack], revision: current.revision + 1 }));
              }}
            /></label>
          </div>
          {(timeline.audioTracks ?? []).map((track, index) => {
            const asset = assets.find((item) => item.id === track.assetId);
            const inKey = timelineNumberDraftKey('audio', track.id, 'sourceIn');
            const outKey = timelineNumberDraftKey('audio', track.id, 'sourceOut');
            const startKey = timelineNumberDraftKey('audio', track.id, 'timelineIn');
            const update = async (patch: Partial<TimelineAudioTrack>, draftKey?: string): Promise<boolean> => {
              try {
                const ok = await save((current) => updateAudioTrack(current, track.id, patch));
                if (!ok) return false;
                if (draftKey) clearNumberDraft(draftKey);
                else setAudioGainDraft((draft) => { const nextDraft = { ...draft }; delete nextDraft[track.id]; return nextDraft; });
                return true;
              }
              catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
            };
            return <article className="timeline-audio-track" key={track.id}>
              <header><b><Music2 size={13} /> {asset?.provenance.displayName ?? `音轨 ${index + 1}`}</b><button type="button" aria-label={`删除音轨 ${index + 1}`} title="删除音轨" disabled={busy} onClick={() => void save((current) => removeAudioTrack(current, track.id))}><Trash2 size={13} /></button></header>
              <label>源入点<input aria-label={`音轨 ${index + 1} 源入点`} type="number" min="0" step="0.001" value={numberDrafts[inKey] ?? seconds(track.sourceInTicks)} onChange={(event) => setNumberDrafts((draft) => ({ ...draft, [inKey]: event.currentTarget.value }))} onBlur={(event) => void commitNumber(inKey, event.currentTarget.value, track.sourceInTicks, (nextTicks) => update({ sourceInTicks: nextTicks }, inKey), `音轨 ${index + 1} 源入点`)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
              <label>源出点<input aria-label={`音轨 ${index + 1} 源出点`} type="number" min="0" step="0.001" value={numberDrafts[outKey] ?? seconds(track.sourceOutTicks)} onChange={(event) => setNumberDrafts((draft) => ({ ...draft, [outKey]: event.currentTarget.value }))} onBlur={(event) => void commitNumber(outKey, event.currentTarget.value, track.sourceOutTicks, (nextTicks) => update({ sourceOutTicks: nextTicks }, outKey), `音轨 ${index + 1} 源出点`)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
              <label>时间线起点<input aria-label={`音轨 ${index + 1} 时间线起点`} type="number" min="0" step="0.001" value={numberDrafts[startKey] ?? seconds(track.timelineInTicks)} onChange={(event) => setNumberDrafts((draft) => ({ ...draft, [startKey]: event.currentTarget.value }))} onBlur={(event) => void commitNumber(startKey, event.currentTarget.value, track.timelineInTicks, (nextTicks) => update({ timelineInTicks: nextTicks }, startKey), `音轨 ${index + 1} 时间线起点`)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
              <label>增益 {Math.round((audioGainDraft[track.id] ?? track.gain) * 100)}%<input aria-label={`音轨 ${index + 1} 增益`} type="range" min="0" max="2" step="0.01" value={audioGainDraft[track.id] ?? track.gain} disabled={busy} onChange={(event) => setAudioGainDraft((draft) => ({ ...draft, [track.id]: Number(event.currentTarget.value) }))} onBlur={(event) => { if (audioGainDraft[track.id] !== undefined) void update({ gain: Number(event.currentTarget.value) }); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
            </article>;
          })}
          <div className="timeline-subtitles">
            <label htmlFor="timeline-srt">字幕草案 (SRT)</label>
            <textarea id="timeline-srt" value={cueText} onChange={(event) => setCueText(event.target.value)} placeholder="1&#10;00:00:00,000 --> 00:00:02,000&#10;输入字幕文本" />
            <button type="button" onClick={() => void saveCues()} disabled={busy}>保存字幕</button>
          </div>
          {timelineIssues.errors.length > 0 && <div className="timeline-error" role="alert"><b>时间线有 {timelineIssues.errors.length} 个问题，保存会被阻止：</b><ul>{timelineIssues.errors.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          {timelineIssues.warnings.length > 0 && <p className="shot-preview-status" role="status">提示：{timelineIssues.warnings.join('、')}</p>}
        </div>
      )}
      {playerUrl && <video className="timeline-player" controls src={playerUrl} />}
      {exportTasks.length > 0 && <div className="timeline-export-tasks" aria-live="polite">{exportTasks.map((task) => <span key={task.id}>{task.status === 'queued' ? '排队中' : task.status === 'running' ? '渲染中' : task.status === 'succeeded' ? '已导出' : task.status === 'failed' ? `导出失败${typeof task.payload.error === 'string' ? ` · ${task.payload.error}` : ''}` : task.status === 'paused' ? '中断后暂停，需要重新预检' : task.status} · {task.id.slice(-8)}</span>)}</div>}
      {error && <p className="timeline-error" role="alert">{error}</p>}
    </section>
  );
}
