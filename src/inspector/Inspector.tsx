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
import { InspectorSection } from './InspectorSection';
import { ModelSection } from './ModelSection';
import { nodeCategoryLabel } from '../domain/production/labels';
import { PromptSection } from './PromptSection';
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
  // 校验要看到真实供应商配置：否则将来加入「模型未配置 / Key 失效」类检查时，
  // 检查面板会因为 providers 是空数组而漏报。
  const profiles = useProviderStore((state) => state.profiles);
  const issues = useMemo(
    () => (board && node ? nodeIssues(board, node.id, { providers: profiles, styleGuide: project?.styleGuide }) : []),
    [board, node, project, profiles],
  );
  const promptable = node ? ['text', 'script', 'image', 'video', 'audio'].includes(node.type) : false;
  const preview = useMemo(
    () => (node && promptable ? promptPreview(node, project?.styleGuide) : undefined),
    [node, promptable, project],
  );
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

  /**
   * 这个节点收不收参考图。
   *
   * 按节点有没有图片输入端口来判断，而不是按 capability：
   * capability 依赖「已经选了模型」，用户还没选模型时参考图入口就不该消失——
   * 恰恰是这时候他最需要知道参考图从哪来。
   */
  const takesReferences = useMemo(() => {
    if (!def) return false;
    return def.inputs.some((port) => port.dataType === 'image' || port.dataType === 'frame');
  }, [def]);

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

  // 注意：所有 hooks 必须在下面的早退之前调用，否则切换选中时 hooks 数量变化会让 React 崩溃（白屏）。
  if (!node || !def) {
    return (
      <aside className="studio-inspector">
        <header className="inspector-head">
          <div>
            <span className="studio-eyebrow">节点属性</span>
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
      useBoardStore.getState().notify(`已拆出 ${result.length} 个视角`, 'success');
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
    useBoardStore.getState().notify('蒙版已保存', 'success');
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
          <span className="studio-eyebrow">{nodeCategoryLabel(def.category)}</span>
          <h2>{def.title}</h2>
        </div>
        <div className="inspector-actions">
          <button type="button" title="复制节点" onClick={duplicateNode}><Copy size={13} /></button>
          <button type="button" title="删除节点" onClick={removeNode}><Trash2 size={13} /></button>
        </div>
      </header>

      <InspectorSection title="字段" defaultOpen>
        {fields.map((field) => (
          <FieldEditor key={field.key} field={field} value={node.data[field.key]} onChange={updateField} />
        ))}
        {!fields.length && <p className="inspector-note">该节点没有可编辑字段。</p>}
      </InspectorSection>

      {capability && (
        <ModelSection
          node={node}
          choices={choices}
          hasKeys={hasKeys}
          capabilityLabel={capabilityLabel(capability)}
          onOpenSettings={openSettings}
        />
      )}

      {preview && (
        <PromptSection node={node} preview={preview} onToggleLock={togglePromptLock} />
      )}

      {/*
        参考图单独成段并默认展开。
        以前它塞在「运行」折叠段里，等于藏起来：用户问「参考图从哪来」，
        根本看不到这个入口。
      */}
      {takesReferences && (
        <InspectorSection title="参考图" defaultOpen>
          <ReferencePicker
            projectId={project?.id}
            selected={referenceIds}
            onToggle={toggleReference}
          />
        </InspectorSection>
      )}

      <InspectorSection
        title="运行"
        aside={<span className="studio-badge">{latestRun ? statusOf(latestRun).label : '未运行'}</span>}
      >
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
      </InspectorSection>

      {maskNode && (
        <InspectorSection
          title="蒙版"
          aside={(
            <button
              type="button"
              className="inspector-link"
              disabled={!maskSourceId}
              onClick={() => setMaskEditorOpen(true)}
            >
              <Brush size={11} /> {maskAssetId ? '重新绘制' : '绘制蒙版'}
            </button>
          )}
        >
          {maskAssetId && maskUrl
            ? <img className="mask-thumb" src={maskUrl} alt="当前蒙版" />
            : <p className="inspector-note">绘制后只重画白色区域，其余像素保持原样。</p>}
          {!maskSourceId && <p className="inspector-warning">先把源图连到「源图」端口并运行上游节点。</p>}
        </InspectorSection>
      )}

      <InspectorSection title="检查" aside={issues.length ? <span className="studio-badge">{issues.length} 项</span> : undefined}>
        <ul className="issue-list">
          {issues.length
            ? issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className={issue.severity}>{issue.message}</li>
            ))
            : <li className="ok">当前节点没有发现问题</li>}
        </ul>
      </InspectorSection>

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
