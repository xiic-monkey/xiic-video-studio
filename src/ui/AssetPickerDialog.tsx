import { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Search } from 'lucide-react';
import { assetThumbUrl } from '../services/tauri';
import { useAssetStore } from '../stores/assetStore';
import type { AssetRef } from '../domain/types';
import { Dialog } from './Dialog';

interface AssetPickerDialogProps {
  open: boolean;
  projectId?: string;
  /** 只看这一类素材；不传则三种都能选。 */
  kind?: 'image' | 'video' | 'audio';
  title?: string;
  onClose(): void;
  onPick(asset: AssetRef): void;
}

/**
 * 从项目素材库里挑一张图。
 *
 * 参考图的来源之一：用户在弹窗里点一张图，选中的素材 id 直接写进
 * 目标节点，不需要先在画布上连线。
 */
export function AssetPickerDialog({ open, projectId, kind, title, onClose, onPick }: AssetPickerDialogProps) {
  const assets = useAssetStore((state) => state.assets);
  const load = useAssetStore((state) => state.load);
  const storedProjectId = useAssetStore((state) => state.projectId);
  const [query, setQuery] = useState('');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    if (projectId && storedProjectId !== projectId) void load(projectId);
  }, [open, projectId, storedProjectId, load]);

  const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片';

  const images = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return assets.filter((item) => {
      if (kind ? item.kind !== kind : item.kind !== 'image') return false;
      if (!keyword) return true;
      const name = item.provenance.displayName ?? '';
      return name.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword);
    });
  }, [assets, query, kind]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const missing = images.filter((item) => !thumbnails[item.id]).slice(0, 24);
    if (!missing.length) return;
    void Promise.all(missing.map(async (item) => {
      if (!projectId) return [item.id, ''] as const;
      const url = await assetThumbUrl(projectId, item.id);
      return [item.id, url] as const;
    })).then((entries) => {
      if (alive) setThumbnails((items) => ({ ...items, ...Object.fromEntries(entries) }));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [open, images, thumbnails, projectId]);

  return (
    <Dialog open={open} onClose={onClose} label={title ?? '选择图片'} className="asset-picker-dialog">
      <header className="settings-head">
        <h2>{title ?? '选择图片'}</h2>
      </header>
      <label className="asset-search-wrap">
        <Search size={12} />
        <input
          className="asset-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索图片名称或 ID"
          aria-label="搜索图片"
        />
      </label>
      <div className="asset-grid">
        {images.slice(0, 60).map((item) => (
          <button
            key={item.id}
            type="button"
            className="asset-card"
            title={item.provenance.displayName ?? item.id}
            onClick={() => { onPick(item); onClose(); }}
          >
            {thumbnails[item.id]
              ? <img src={thumbnails[item.id]} alt="" />
              : <span className="asset-icon"><ImageIcon size={14} /></span>}
          </button>
        ))}
        {!images.length && (
          <p className="inspector-note">
            项目里还没有{label}。可以在素材节点里「导入本地{label}」，或先生成一个。
          </p>
        )}
      </div>
    </Dialog>
  );
}
