import { useEffect, useState } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import { assetThumbUrl } from '../services/tauri';
import { useAssetStore } from '../stores/assetStore';
import { AssetPickerDialog } from '../ui/AssetPickerDialog';

export interface ReferencePickerProps {
  projectId?: string;
  /** 已选中的参考图资产 id。 */
  selected: string[];
  /** 切换某个参考图。 */
  onToggle(assetId: string): void;
}

/**
 * 节点级参考图。
 *
 * 一直显示，不藏起来：参考图是节点能不能做「图生图」的关键，
 * 折叠成一个小链接的话，用户根本不知道节点支持参考图。
 * 两种给法都在这里：
 * - 从项目素材里挑一张；
 * - 或者在画布上拖一张图片到「图片素材」节点，再连到参考图端口。
 */
export function ReferencePicker({ projectId, selected, onToggle }: ReferencePickerProps) {
  const assets = useAssetStore((state) => state.assets);
  const [open, setOpen] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const chosen = selected
    .map((id) => assets.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  useEffect(() => {
    let alive = true;
    const missing = chosen.filter((item) => !thumbs[item.id]);
    if (!missing.length) return;
    void Promise.all(missing.map(async (item) => {
      if (!projectId) return [item.id, ''] as const;
      const url = await assetThumbUrl(projectId, item.id);
      return [item.id, url] as const;
    })).then((entries) => {
      if (alive) setThumbs((items) => ({ ...items, ...Object.fromEntries(entries) }));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [chosen, thumbs, projectId]);

  return (
    <div className="reference-picker">
      <div className="reference-picker-head">
        <span>{selected.length ? `已选 ${selected.length} 张` : '还没选'}</span>
        <button type="button" className="inspector-link" onClick={() => setOpen(true)}>选择图片</button>
      </div>
      {chosen.length > 0 ? (
        <div className="reference-grid">
          {chosen.map((item) => (
            <button
              key={item.id}
              type="button"
              className="active"
              title={`${item.provenance.displayName ?? item.id}（点击移除）`}
              onClick={() => onToggle(item.id)}
            >
              {thumbs[item.id] ? <img src={thumbs[item.id]} alt="" /> : <span className="asset-icon"><ImageIcon size={14} /></span>}
              <span className="reference-remove"><X size={10} /></span>
            </button>
          ))}
        </div>
      ) : (
        <p className="inspector-note">
          还没有参考图：从素材里挑一张，或把图片拖进画布接到「参考图」端口。
        </p>
      )}
      <p className="inspector-note">参考图会随运行一起发出；有参考图的节点按图生图处理。</p>
      <AssetPickerDialog
        open={open}
        projectId={projectId}
        title="选择参考图"
        onClose={() => setOpen(false)}
        onPick={(asset) => onToggle(asset.id)}
      />
    </div>
  );
}
