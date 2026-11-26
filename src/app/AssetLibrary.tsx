import { useEffect, useMemo, useState } from 'react';
import { FileAudio, FileText, Film, Image as ImageIcon, Search, Upload, X } from 'lucide-react';
import { assetThumbUrl, deleteProjectAsset, importMedia } from '../services/tauri';
import { createNode, sourceNodeType } from '../domain/nodes/definitions';
import { useBoardStore } from '../stores/boardStore';
import { useAssetStore } from '../stores/assetStore';
import { confirmAction } from '../ui/confirmStore';
import type { AssetRef } from '../domain/types';

const KIND_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
  json: '数据',
};

const KINDS = ['', 'image', 'video', 'audio', 'text'];

/** 资产库一次最多渲染多少个卡片。超出部分用「加载更多」逐批展开。 */
const PAGE_SIZE = 60;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface AssetLibraryProps {
  projectId?: string;
  /** 抽屉形态下由外层提供关闭按钮。 */
  onClose?: () => void;
}

/**
 * 资产库：生成出来与导入的素材按类型集中管理。
 *
 * 数据来自 assetStore，左栏入口的计数与这里的网格是同一份数据。
 */
export function AssetLibrary({ projectId, onClose }: AssetLibraryProps) {
  const assets = useAssetStore((state) => state.assets);
  const storedProjectId = useAssetStore((state) => state.projectId);
  const load = useAssetStore((state) => state.load);
  const refresh = useAssetStore((state) => state.refresh);
  const removeLocal = useAssetStore((state) => state.remove);
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selectedId, setSelectedId] = useState<string>();
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  // 组件被单独使用（不是走左栏入口）时也要能自己把数据拉起来。
  useEffect(() => {
    if (projectId && storedProjectId !== projectId) void load(projectId);
  }, [projectId, storedProjectId, load]);

  async function importFiles() {
    if (!projectId || importing) return;
    setImporting(true);
    setMessage(undefined);
    try {
      const task = await importMedia(projectId);
      if (task) {
        await refresh();
        setMessage({ ok: task.status === 'succeeded', text: task.status === 'succeeded' ? '素材已导入' : '没有可导入的素材' });
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setImporting(false);
    }
  }

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return assets.filter((item) => {
      if (kind && item.kind !== kind) return false;
      if (!keyword) return true;
      const name = item.provenance.displayName ?? '';
      return name.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword);
    });
  }, [assets, kind, query]);

  // 换筛选条件时重置展开数量：否则「显示更多」会留下一半旧结果的偏移。
  useEffect(() => { setLimit(PAGE_SIZE); }, [kind, query]);

  useEffect(() => {
    let alive = true;
    const missing = visible
      .filter((item) => item.kind === 'image' && !thumbnails[item.id])
      .slice(0, 24);
    if (!missing.length) return;
    void Promise.all(missing.map(async (item) => {
      if (!projectId) return [item.id, ''] as const;
      const url = await assetThumbUrl(projectId, item.id);
      return [item.id, url] as const;
    })).then((entries) => {
      if (alive) setThumbnails((items) => ({ ...items, ...Object.fromEntries(entries) }));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [visible, thumbnails]);

  const selected = assets.find((item) => item.id === selectedId);
  // 素材节点分三种：图片 / 视频 / 音频。文本与数据没有对应节点。
  const selectedKind = selected && (selected.kind === 'image' || selected.kind === 'video' || selected.kind === 'audio')
    ? selected.kind
    : undefined;
  function addSelectedToCanvas() {
    if (!selected || !selectedKind) return;
    const boardState = useBoardStore.getState();
    const board = boardState.board;
    if (!board) return;
    const sourceNode = createNode(sourceNodeType(selectedKind), { x: 120, y: 120 }, {
      assetId: selected.id,
      kind: selectedKind,
      displayName: selected.provenance.displayName ?? selected.id,
    });
    boardState.apply({ type: 'addNode', node: sourceNode });
    boardState.select(sourceNode.id);
    boardState.notify('已添加到画布', 'success');
  }

  async function removeSelected() {
    if (!selected || !projectId) return;
    const confirmed = await confirmAction({
      title: '移除素材',
      message: `确定从项目中移除「${selected.provenance.displayName ?? selected.id}」？`,
      detail: '素材文件仍保留在磁盘上，重新导入即可使用。',
      tone: 'danger',
      confirmText: '移除',
    });
    if (!confirmed) return;
    try {
      await deleteProjectAsset(projectId, selected.id);
      removeLocal(selected.id);
      setSelectedId(undefined);
      setMessage({ ok: true, text: '素材已从项目中移除' });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    }
  }

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    assets.forEach((item) => map.set(item.kind, (map.get(item.kind) ?? 0) + 1));
    return map;
  }, [assets]);

  return (
    <section className="asset-library">
      <header className="asset-library-head">
        <h2>资产库</h2>
        <span className="studio-badge">{assets.length}</span>
        {onClose && (
          <button type="button" className="studio-icon-button" title="关闭资产库" aria-label="关闭资产库" onClick={onClose}>
            <X size={15} />
          </button>
        )}
      </header>
      <button type="button" className="studio-button secondary" disabled={!projectId || importing} onClick={() => void importFiles()}>
        <Upload size={14} /> {importing ? '正在导入…' : '导入本地素材'}
      </button>
      <label className="asset-search-wrap">
        <Search size={12} />
        <input
          className="asset-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索素材名称或 ID"
          aria-label="搜索素材"
        />
      </label>
      {message && (
        <p className={`asset-library-message ${message.ok ? 'ok' : 'error'}`} role="status">{message.text}</p>
      )}
      <div className="asset-kinds">
        {KINDS.map((value) => (
          <button
            key={value || 'all'}
            type="button"
            className={kind === value ? 'active' : ''}
            onClick={() => setKind(value)}
          >
            {value ? KIND_LABEL[value] ?? value : '全部'}
            {value ? ` ${counts.get(value) ?? 0}` : ` ${assets.length}`}
          </button>
        ))}
      </div>
      <div className="asset-grid">
        {visible.slice(0, limit).map((item) => (
          <button
            key={item.id}
            type="button"
            className={`asset-card ${item.id === selectedId ? 'active' : ''}`}
            title={item.provenance.displayName ?? item.id}
            onClick={() => setSelectedId(item.id === selectedId ? undefined : item.id)}
          >
            {item.kind === 'image' && thumbnails[item.id]
              ? <img src={thumbnails[item.id]} alt="" />
              : (
                <span className="asset-icon">
                  {item.kind === 'video' ? <Film size={14} />
                    : item.kind === 'audio' ? <FileAudio size={14} />
                      : item.kind === 'text' || item.kind === 'json' ? <FileText size={14} />
                        : <ImageIcon size={14} />}
                </span>
              )}
          </button>
        ))}
        {!visible.length && <span className="studio-badge">暂无资产</span>}
      </div>
      {visible.length > limit && (
        <button type="button" className="studio-button secondary" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
          显示更多（还有 {visible.length - limit} 个）
        </button>
      )}
      {selected && (
        <div className="asset-detail">
          <b>{KIND_LABEL[selected.kind] ?? selected.kind}</b>
          <span>{selected.provenance.displayName ?? selected.id.slice(0, 10)}</span>
          <span>{formatBytes(selected.bytes)} · {new Date(selected.createdAt).toLocaleString('zh-CN')}</span>
          {selected.width && selected.height && <span>{selected.width}×{selected.height}</span>}
          {typeof selected.provenance?.model === 'string' && <span>模型：{selected.provenance.model}</span>}
          {typeof selected.provenance?.nodeId === 'string' && <span>节点：{selected.provenance.nodeId.slice(-8)}</span>}
          <div className="asset-detail-actions">
            {selectedKind && (
              <button type="button" className="studio-button secondary" onClick={addSelectedToCanvas}>添加到画布</button>
            )}
            <button type="button" className="studio-button danger" onClick={() => void removeSelected()}>移除</button>
          </div>
        </div>
      )}
    </section>
  );
}
