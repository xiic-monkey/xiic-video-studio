import { useEffect, useMemo, useState } from 'react';
import { Copy, Lock, Trash2, Unlock } from 'lucide-react';
import { createNode, getNodeDefinition } from '../domain/nodes/definitions';
import type { FieldDef } from '../domain/nodes/types';
import { nodeIssues } from '../domain/graph/validate';
import { selectRunCandidate } from '../services/tauri';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';
import { useRunStore } from '../stores/runStore';
import { useStudioStore } from '../stores/studioStore';
import { statusOf } from '../nodes/summary';
import { CandidateList } from './CandidateList';
import { FieldEditor, type FieldChangeOptions } from './FieldEditor';
import { RunHistory } from './RunHistory';
import {
  candidateKind,
  capabilityForNode,
  capabilityLabel,
  modelOptions,
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

  const def = node ? getNodeDefinition(node.type) : undefined;
  const nodeRuns = useMemo(
    () => Object.values(runs)
      .filter((run) => run.nodeId === nodeId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [runs, nodeId],
  );
  const latestRun = nodeRuns[0];
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
  const options = useMemo(
    () => (capability ? modelOptions(profiles, capability) : []),
    [profiles, capability],
  );

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
        {def.fields.map((field) => (
          <FieldEditor key={field.key} field={field} value={node.data[field.key]} onChange={updateField} />
        ))}
        {!def.fields.length && <p className="inspector-note">该节点没有可编辑字段。</p>}
      </section>

      {capability && (
        <section className="inspector-section">
          <h3>模型</h3>
          <div className="inspector-field">
            <span>运行模型</span>
            <select
              value={(() => {
                const providerId = String(node.data.providerId ?? '');
                const modelId = String(node.data.model ?? '');
                return options.some((option) => option.providerId === providerId && option.modelId === modelId)
                  ? `${providerId}|${modelId}`
                  : '';
              })()}
              onChange={(event) => {
                const [providerId, modelId] = event.target.value.split('|');
                useBoardStore.getState().apply({
                  type: 'setNodeData',
                  nodeId: node.id,
                  patch: { providerId: providerId ?? '', model: modelId ?? '' },
                });
              }}
            >
              <option value="">自动选择</option>
              {options.map((option) => (
                <option key={`${option.providerId}|${option.modelId}`} value={`${option.providerId}|${option.modelId}`}>
                  {option.providerName} · {option.modelName}
                </option>
              ))}
            </select>
          </div>
          <div className="inspector-section-head">
            <span className="inspector-note">能力：{capabilityLabel(capability)}</span>
            <button type="button" className="inspector-link" onClick={openSettings}>打开设置</button>
          </div>
          {!options.length && <p className="inspector-warning">没有可用模型，请先在设置中添加模型并保存 Key。</p>}
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
        <RunHistory runs={nodeRuns} />
        {latestRun && (
          <CandidateList
            run={latestRun}
            kind={candidateKind(node.type)}
            busy={busy}
            onSelect={(assetId) => { void chooseCandidate(assetId); }}
          />
        )}
      </section>

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
    </aside>
  );
}
