import { useEffect, useMemo, useState } from 'react';
import { FileAudio, FileText, Film, Image as ImageIcon, Upload } from 'lucide-react';
import { assetThumbUrl, importMedia, listAssets } from '../services/tauri';
import { createNode } from '../domain/nodes/definitions';
import { useBoardStore } from '../stores/boardStore';
import type { AssetRef } from '../domain/types';

const KIND_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
  json: '数据',
};

const KINDS = ['', 'image', 'video', 'audio', 'text'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 资产库：生成出来与导入的素材按类型集中管理。 */
export function AssetLibrary({ projectId }: { projectId?: string }) {
  const [assets, setAssets] = useState<AssetRef[]>([]);
  const [kind, setKind] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    void listAssets(projectId).then((items) => {
      if (alive) setAssets(items);
    }).catch(() => {
      if (alive) setAssets([]);
    });
    return () => { alive = false; };
  }, [projectId, refresh]);

  async function importFiles() {
    if (!projectId || importing) return;
    setImporting(true);
    setMessage('');
    try {
      const task = await importMedia(projectId);
      if (task) {
        setRefresh((value) => value + 1);
        setMessage(task.status === 'succeeded' ? '素材已导入' : '没有可导入的素材');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  const visible = useMemo(
    () => (kind ? assets.filter((item) => item.kind === kind) : assets),
    [assets, kind],
  );

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
  function addSelectedToCanvas() {
    if (!selected) return;
    const boardState = useBoardStore.getState();
    const board = boardState.board;
    if (!board) return;
    const sourceNode = createNode('media_source', { x: 120, y: 120 }, { assetId: selected.id, kind: selected.kind, displayName: selected.provenance.displayName ?? selected.id });
    boardState.apply({ type: 'addNode', node: sourceNode });
    boardState.select(sourceNode.id);
    boardState.notify('已添加到画布');
  }
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    assets.forEach((item) => map.set(item.kind, (map.get(item.kind) ?? 0) + 1));
    return map;
  }, [assets]);

  return (
    <section className="asset-library">
      <h2>资产库</h2>
      <button type="button" disabled={!projectId || importing} onClick={() => void importFiles()}>
        <Upload size={14} /> {importing ? '正在导入…' : '导入本地素材'}
      </button>
      {message && <span role="status">{message}</span>}
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
        {visible.slice(0, 60).map((item) => (
          <button
            key={item.id}
            type="button"
            className={`asset-card ${item.id === selectedId ? 'active' : ''}`}
            title={item.id}
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
      {selected && (
        <div className="asset-detail">
          <b>{KIND_LABEL[selected.kind] ?? selected.kind}</b>
          <span>{formatBytes(selected.bytes)} · {new Date(selected.createdAt).toLocaleString('zh-CN')}</span>
          {selected.width && selected.height && <span>{selected.width}×{selected.height}</span>}
          {typeof selected.provenance?.model === 'string' && <span>模型：{selected.provenance.model}</span>}
          {typeof selected.provenance?.nodeId === 'string' && <span>节点：{selected.provenance.nodeId.slice(-8)}</span>}
          <button type="button" onClick={addSelectedToCanvas}>添加到画布</button>
        </div>
      )}
    </section>
  );
}
