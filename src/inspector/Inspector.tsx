import { useEffect, useMemo, useState } from 'react';
import { Brush, CircleSlash, Copy, Lock, Pin, Play, Trash2, Unlock } from 'lucide-react';
import { createNode, getNodeDefinition } from '../domain/nodes/definitions';
import { isMaskNode, maskAssetIdOf, sourceAssetIdOf } from '../domain/nodes/mask';
import { referenceIdsOf, splitLayoutFor, SPLITTABLE_NODES, viewsOf } from '../domain/nodes/sheet';
import { fieldDefsFor } from '../domain/providers/routing';
import type { FieldDef } from '../domain/nodes/types';
import { nodeIssues } from '../domain/graph/validate';
import { selectedAssetOf } from '../domain/graph/cacheKey';
import { assetThumbUrl, selectRunCandidate, splitSheet } from '../services/tauri';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';
import { useRunStore } from '../stores/runStore';
import { useStudioStore } from '../stores/studioStore';
import { useRunController } from '../run/controller';
import { useStaleNodeIds } from '../run/useStaleNodeIds';
import { statusOf } from '../nodes/summary';
import { CandidateList } from './CandidateList';
import { FieldEditor, type FieldChangeOptions } from './FieldEditor';
import { MaskEditor } from './MaskEditor';
import { ReferencePicker } from './ReferencePicker';
import { RunHistory } from './RunHistory';
import {
  candidateKind,
  capabilityForNode,
  capabilityLabel,
  modelChoices,
  promptPreview,
  pruneCommandsForMode,
} from './model';

export function Inspector() {
  const board = useBoardStore((state) => state.board);
  const nodeId = useBoardStore((state) => state.selectedNodeId);
  const node = nodeId && board ? board.nodes[nodeId] : undefined;
  const project = useStudioStore((state) => state.projects.find((item) => item.id === state.currentProjectId));
  const runs = useRunStore((state) => state.runs);
  const [busy, setBusy] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [viewThumbs, setViewThumbs] = useState<Record<string, string>>({});
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
  const [maskUrl, setMaskUrl] = useState('');
  const requestRun = useRunController((state) => state.requestRun);
  const cancelActiveRun = useRunController((state) => state.cancelRun);
  const runBusy = useRunController((state) => Boolean(nodeId && state.busy[nodeId]));
  const staleNodeIds = useStaleNodeIds();
  const isStale = Boolean(nodeId && staleNodeIds.has(nodeId));

  const def = node ? getNodeDefinition(node.type) : undefined;
  const nodeRuns = useMemo(
    () => Object.values(runs)
      .filter((run) => run.nodeId === nodeId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [runs, nodeId],
  );
  const latestRun = nodeRuns[0];
  const activeRun = latestRun && (latestRun.status === 'queued' || latestRun.status === 'running');
  const issues = useMemo(
    () => (board && node ? nodeIssues(board, node.id, { providers: [], styleGuide: project?.styleGuide }) : []),
    [board, node, project],
  );
  const promptable = node ? ['text', 'image', 'video', 'audio'].includes(node.type) : false;
  const preview = useMemo(
    () => (node && promptable ? promptPreview(node, project?.styleGuide) : undefined),
    [node, promptable, project],
  );
  const profiles = useProviderStore((state) => state.profiles);
  const hasKeys = useProviderStore((state) => state.hasKeys);
  const openSettings = useProviderStore((state) => state.openSettings);
  const capability = board && node ? capabilityForNode(board, node) : undefined;
  const choices = useMemo(
    () => (capability ? modelChoices(profiles, capability) : []),
    [profiles, capability],
  );
  const selectedChoice = useMemo(
    () => choices.find((choice) => choice.modelId === String(node?.data.model ?? '')),
    [choices, node?.data.model],
  );

  // 参数表跟着所选模型走：目录里定义了什么就渲染什么，没选模型时用节点自带字段。
  const fields = useMemo(() => {
    if (!def) return [];
    if (!capability || !selectedChoice) return def.fields;
    const dynamic = fieldDefsFor(selectedChoice.modelId, capability);
    if (!dynamic.length) return def.fields;
    const dynamicKeys = new Set(dynamic.map((field) => field.key));
    // 节点自带字段保留，只有与目录参数同名的那些（时长、尺寸、画质…）让位给模型定义。
    const kept = def.fields.filter((field) => !dynamicKeys.has(field.key));
    return [...kept, ...dynamic];
  }, [capability, selectedChoice, def]);

  useEffect(() => {
    setBusy(false);
  }, [nodeId]);

  if (!node || !def) {
    return (
      <aside className="studio-inspector">
        <header className="inspector-head">
          <div>
            <span className="studio-eyebrow">INSPECTOR</span>
            <h2>节点属性</h2>
          </div>
        </header>
        <div className="inspector-empty">
          <p className="inspector-note">在画布中选中节点后，在这里编辑字段、预览提示词、查看运行历史与候选。</p>
        </div>
      </aside>
    );
  }

  const activeNode = node;
  const activeDef = def;

  function updateField(field: FieldDef, value: unknown, options: FieldChangeOptions) {
    if (activeNode.type === 'video' && field.key === 'mode') {
      const mode = value as 't2v' | 'firstLast' | 'reference';
      const commands = board ? pruneCommandsForMode(board, activeNode.id, mode) : [];
      if (commands.length) useBoardStore.getState().applyMany(commands);
      return;
    }
    useBoardStore.getState().apply({ type: 'setNodeData', nodeId: activeNode.id, patch: { [field.key]: value } }, options);
  }

  function duplicateNode() {
    const copy = createNode(activeNode.type, { x: activeNode.position.x + 40, y: activeNode.position.y + 40 }, activeNode.data);
    useBoardStore.getState().apply({ type: 'addNode', node: copy });
    useBoardStore.getState().select(copy.id);
  }

  function removeNode() {
    useBoardStore.getState().apply({ type: 'removeNode', nodeId: activeNode.id });
    useBoardStore.getState().selectMany([]);
  }

  function togglePromptLock() {
    if (!preview) return;
    const locked = Boolean(activeNode.data.promptLocked);
    useBoardStore.getState().apply({
      type: 'setNodeData',
      nodeId: activeNode.id,
      patch: locked
        ? { promptLocked: false, promptOverride: '' }
        : { promptLocked: true, promptOverride: preview.text },
    });
  }

  const splitSource = latestRun ? selectedAssetOf(latestRun) : undefined;
  const splitLayout = node ? splitLayoutFor(node) : undefined;
  // viewsOf 每次都返回新数组：不 memo 的话下面取缩略图的 effect 每次渲染都会重跑。
  const views = useMemo(() => (node ? viewsOf(node) : []), [node]);
  const referenceIds = useMemo(() => (node ? referenceIdsOf(node) : []), [node]);
  const maskNode = Boolean(node && isMaskNode(node));
  const maskSourceId = board && nodeId ? sourceAssetIdOf(board, nodeId, Object.values(runs)) : undefined;
  const maskAssetId = node ? maskAssetIdOf(node) : undefined;

  useEffect(() => {
    let alive = true;
    if (!maskAssetId) {
      setMaskUrl('');
      return;
    }
    void assetThumbUrl(project?.id ?? '', maskAssetId).then((url) => {
      if (alive) setMaskUrl(url);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [maskAssetId]);

  useEffect(() => {
    let alive = true;
    const missing = views.filter((view) => !viewThumbs[view.assetId]);
    if (!missing.length) return;
    void Promise.all(missing.map(async (view) => {
      const url = await assetThumbUrl(project?.id ?? '', view.assetId);
      return [view.assetId, url] as const;
    })).then((entries) => {
      if (alive) setViewThumbs((items) => ({ ...items, ...Object.fromEntries(entries) }));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [views, viewThumbs]);

  async function runSplit() {
    if (!node || !splitSource || !splitLayout) return;
    setSplitting(true);
    try {
      const result = await splitSheet(
        splitSource,
        splitLayout as 'landscape' | 'portrait',
        node.id,
        project?.id ?? '',
      );
      useBoardStore.getState().apply({
        type: 'setNodeData',
        nodeId: node.id,
        patch: { views: result },
      });
      useBoardStore.getState().notify(`已拆出 ${result.length} 个视角`);
    } catch (error) {
      useBoardStore.getState().notify(error instanceof Error ? error.message : String(error));
    } finally {
      setSplitting(false);
    }
  }

  function toggleReference(assetId: string) {
    if (!node) return;
    const next = referenceIds.includes(assetId)
      ? referenceIds.filter((id) => id !== assetId)
      : [...referenceIds, assetId];
    useBoardStore.getState().apply({
      type: 'setNodeData',
      nodeId: node.id,
      patch: { referenceAssetIds: next },
    });
  }

  function onMaskSaved(assetId: string) {
    if (!nodeId) return;
    useBoardStore.getState().apply({
      type: 'setNodeData',
      nodeId,
      patch: { maskAssetId: assetId },
    });
    useBoardStore.getState().notify('蒙版已保存');
    setMaskEditorOpen(false);
  }

  async function chooseCandidate(assetId: string) {
    if (!latestRun) return;
    setBusy(true);
    try {
      const updated = await selectRunCandidate(latestRun.id, assetId);
      useRunStore.getState().upsertRun(updated);
    } catch (error) {
      useBoardStore.getState().notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="studio-inspector">
      <header className="inspector-head">
        <div>
          <span className="studio-eyebrow">{def.category}</span>
          <h2>{def.title}</h2>
        </div>
        <div className="inspector-actions">
          <button type="button" title="复制节点" onClick={duplicateNode}><Copy size={13} /></button>
          <button type="button" title="删除节点" onClick={removeNode}><Trash2 size={13} /></button>
        </div>
      </header>

      <section className="inspector-section">
        <h3>字段</h3>
        {fields.map((field) => (
          <FieldEditor key={field.key} field={field} value={node.data[field.key]} onChange={updateField} />
        ))}
        {!fields.length && <p className="inspector-note">该节点没有可编辑字段。</p>}
      </section>

      {capability && (
        <section className="inspector-section">
          <h3>模型</h3>
          <div className="inspector-field">
            <span>模型</span>
            <select
              value={String(node.data.model ?? '')}
              onChange={(event) => {
                const modelId = event.target.value;
                const providerId = String(node.data.providerId ?? '');
                const stillValid = choices.some((choice) => choice.modelId === modelId
                  && choice.providers.some((provider) => provider.providerId === providerId));
                useBoardStore.getState().apply({
                  type: 'setNodeData',
                  nodeId: node.id,
                  patch: { model: modelId, providerId: stillValid ? providerId : '' },
                });
              }}
            >
              <option value="">请选择模型</option>
              {choices.map((choice) => (
                <option key={choice.modelId} value={choice.modelId}>{choice.modelName}</option>
              ))}
            </select>
          </div>
          <div className="inspector-field">
            <span>供应商</span>
            <select
              value={String(node.data.providerId ?? '')}
              disabled={!selectedChoice}
              onChange={(event) => {
                useBoardStore.getState().apply({
                  type: 'setNodeData',
                  nodeId: node.id,
                  patch: { providerId: event.target.value },
                });
              }}
            >
              <option value="">自动（按顺序回退）</option>
              {selectedChoice?.providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>{provider.providerName}</option>
              ))}
            </select>
          </div>
          <div className="inspector-section-head">
            <span className="inspector-note">能力：{capabilityLabel(capability)}</span>
            <button type="button" className="inspector-link" onClick={openSettings}>打开设置</button>
          </div>
          {!choices.length && <p className="inspector-warning">没有可用模型，请先在设置中添加模型并保存 Key。</p>}
          {selectedChoice && (
            <p className="inspector-note">
              候选顺序：{selectedChoice.providers.map((provider) => provider.providerName).join(' → ')}
            </p>
          )}
          {String(node.data.providerId ?? '') && hasKeys[String(node.data.providerId)] === false && (
            <p className="inspector-warning">所选 Provider 尚未保存 API Key。</p>
          )}
        </section>
      )}

      {preview && (
        <section className="inspector-section">
          <div className="inspector-section-head">
            <h3>提示词预览</h3>
            <button type="button" className="inspector-link" onClick={togglePromptLock}>
              {node.data.promptLocked ? <><Unlock size={11} /> 解锁</> : <><Lock size={11} /> 锁定</>}
            </button>
          </div>
          <p className="prompt-preview">{preview.text || '（空）'}</p>
          {preview.negative && <p className="inspector-note">负向：{preview.negative}</p>}
          {!!preview.segments.length && (
            <div className="prompt-segments">
              {preview.segments.map((segment, index) => (
                <span key={`${segment.key}-${index}`} title={segment.text}>{segment.label}</span>
              ))}
            </div>
          )}
          {!!preview.missingVariables?.length && (
            <p className="inspector-warning">缺少变量：{preview.missingVariables.join('、')}</p>
          )}
        </section>
      )}

      <section className="inspector-section">
        <div className="inspector-section-head">
          <h3>运行</h3>
          <span className="studio-badge">{latestRun ? statusOf(latestRun).label : '未运行'}</span>
        </div>
        {isStale && <p className="inspector-warning">上游已更新，当前结果已过期；确认后再运行，不会自动重跑。</p>}
        <div className="inspector-run">
          <button
            type="button"
            className="studio-button"
            disabled={!def.actions.length || runBusy || Boolean(activeRun)}
            onClick={() => nodeId && void requestRun(nodeId)}
          >
            <Play size={12} /> {runBusy ? '准备中…' : '运行'}
          </button>
          <button
            type="button"
            className="studio-button secondary"
            disabled={!activeRun}
            onClick={() => nodeId && void cancelActiveRun(nodeId)}
          >
            <CircleSlash size={12} /> 取消
          </button>
          <button
            type="button"
            className="inspector-link"
            title="锁定后不再被标记为过期"
            onClick={() => useBoardStore.getState().apply({
              type: 'setNodeUi',
              nodeId: node.id,
              patch: { pinned: !node.ui?.pinned },
            })}
          >
            <Pin size={11} /> {node.ui?.pinned ? '解除锁定' : '锁定结果'}
          </button>
        </div>
        {SPLITTABLE_NODES.has(activeNode.type) && (
          <>
            <div className="inspector-section-head">
              <span className="inspector-note">拆帧</span>
              <button
                type="button"
                className="inspector-link"
                disabled={!splitSource || splitting}
                onClick={() => { void runSplit(); }}
              >
                {splitting ? '拆帧中…' : '拆成单张'}
              </button>
            </div>
            {views.length ? (
              <div className="sheet-views">
                {views.map((view) => (
                  <button
                    key={view.assetId}
                    type="button"
                    className={referenceIds.includes(view.assetId) ? 'active' : ''}
                    title={`${view.label}（点击${referenceIds.includes(view.assetId) ? '取消' : '设为'}参考图）`}
                    onClick={() => toggleReference(view.assetId)}
                  >
                    {viewThumbs[view.assetId] && <img src={viewThumbs[view.assetId]} alt={view.label} />}
                    <span>{view.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="inspector-note">运行后可拆成单张视角，勾选后作为本节点的参考图。</p>
            )}
            {referenceIds.length > 0 && (
              <p className="inspector-note">已选 {referenceIds.length} 张作为参考图，会随运行一起发出。</p>
            )}
          </>
        )}
        {capability && (
          <ReferencePicker
            projectId={project?.id}
            selected={referenceIds}
            onToggle={toggleReference}
          />
        )}
        <RunHistory runs={nodeRuns} />
        {latestRun && (
          <CandidateList
            run={latestRun}
            kind={candidateKind(node.type)}
            busy={busy}
            onSelect={(assetId) => { void chooseCandidate(assetId); }}
          />
        )}
        {latestRun?.route?.length ? (
          <div className="route-trace">
            <span className="inspector-note">路由轨迹</span>
            {latestRun.route.map((attempt, index) => (
              <span key={`${attempt.providerId}-${index}`} className={attempt.ok ? 'ok' : 'fail'}>
                {attempt.providerName} · {attempt.keyLabel}
                {attempt.code ? ` → ${attempt.code}` : ''}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {maskNode && (
        <section className="inspector-section">
          <div className="inspector-section-head">
            <h3>蒙版</h3>
            <button
              type="button"
              className="inspector-link"
              disabled={!maskSourceId}
              onClick={() => setMaskEditorOpen(true)}
            >
              <Brush size={11} /> {maskAssetId ? '重新绘制' : '绘制蒙版'}
            </button>
          </div>
          {maskAssetId && maskUrl
            ? <img className="mask-thumb" src={maskUrl} alt="当前蒙版" />
            : <p className="inspector-note">绘制后只重画白色区域，其余像素保持原样。</p>}
          {!maskSourceId && <p className="inspector-warning">先把源图连到「源图」端口并运行上游节点。</p>}
        </section>
      )}

      <section className="inspector-section">
        <h3>检查</h3>
        <ul className="issue-list">
          {issues.length
            ? issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className={issue.severity}>{issue.message}</li>
            ))
            : <li className="ok">当前节点没有发现问题</li>}
        </ul>
      </section>

      {maskEditorOpen && maskSourceId && nodeId && (
        <MaskEditor
          sourceAssetId={maskSourceId}
          nodeId={nodeId}
          projectId={project?.id ?? ''}
          onClose={() => setMaskEditorOpen(false)}
          onSaved={(asset) => onMaskSaved(asset.assetId)}
        />
      )}
    </aside>
  );
}
