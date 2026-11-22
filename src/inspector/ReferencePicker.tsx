import { useEffect, useState } from 'react';
import { assetThumbUrl, listAssets } from '../services/tauri';
import type { AssetRef } from '../domain/types';

export interface ReferencePickerProps {
  projectId?: string;
  /** 已选中的参考图资产 id。 */
  selected: string[];
  /** 切换某个参考图。 */
  onToggle(assetId: string): void;
}

/** 从资产库里挑参考图（跨节点复用的入口）。 */
export function ReferencePicker({ projectId, selected, onToggle }: ReferencePickerProps) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<AssetRef[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listAssets(projectId).then((items) => {
      if (alive) setAssets(items.filter((item) => item.kind === 'image'));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [open, projectId]);

  useEffect(() => {
    let alive = true;
    const missing = assets.filter((item) => !thumbs[item.id]).slice(0, 12);
    if (!missing.length) return;
    void Promise.all(missing.map(async (item) => {
      if (!projectId) return [item.id, ''] as const;
      const url = await assetThumbUrl(projectId, item.id);
      return [item.id, url] as const;
    })).then((entries) => {
      if (alive) setThumbs((items) => ({ ...items, ...Object.fromEntries(entries) }));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [assets, thumbs]);

  return (
    <div className="reference-picker">
      <button type="button" className="inspector-link" onClick={() => setOpen((value) => !value)}>
        {open ? '收起资产库' : '从资产库选参考图'}
      </button>
      {open && (
        <div className="reference-grid">
          {assets.slice(0, 12).map((asset) => (
            <button
              key={asset.id}
              type="button"
              className={selected.includes(asset.id) ? 'active' : ''}
              title={asset.id}
              onClick={() => onToggle(asset.id)}
            >
              {thumbs[asset.id] && <img src={thumbs[asset.id]} alt="" />}
            </button>
          ))}
          {!assets.length && <span className="inspector-note">资产库里还没有图片。</span>}
        </div>
      )}
    </div>
  );
}
