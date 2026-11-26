import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Eraser, Paintbrush, Save, Trash2, X } from 'lucide-react';
import { maskPaintedRatio } from '../domain/nodes/mask';
import { assetUrl, saveMask, type MaskAsset } from '../services/tauri';

interface MaskEditorProps {
  sourceAssetId: string;
  nodeId: string;
  projectId: string;
  onClose(): void;
  onSaved(asset: MaskAsset): void;
}

type Point = { x: number; y: number };

/** 在源图上画蒙版：白色半透明是要重绘的区域，其余保持原样。 */
export function MaskEditor({ sourceAssetId, nodeId, projectId, onClose, onSaved }: MaskEditorProps) {
  const displayRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<Point | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [brush, setBrush] = useState(48);
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush');
  const [coverage, setCoverage] = useState(0);

  function render() {
    const display = displayRef.current;
    const image = imageRef.current;
    const mask = maskRef.current;
    if (!display || !image || !mask) return;
    const ctx = display.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, display.width, display.height);
    ctx.drawImage(image, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.drawImage(mask, 0, 0);
    ctx.restore();
  }

  useEffect(() => {
    let alive = true;
    void assetUrl(projectId, sourceAssetId).then((url) => {
      const image = new Image();
      image.onload = () => {
        if (!alive) return;
        imageRef.current = image;
        const mask = document.createElement('canvas');
        mask.width = image.naturalWidth;
        mask.height = image.naturalHeight;
        maskRef.current = mask;
        const display = displayRef.current;
        if (display) {
          display.width = image.naturalWidth;
          display.height = image.naturalHeight;
        }
        render();
        setReady(true);
      };
      image.onerror = () => { if (alive) setError('源图加载失败'); };
      image.src = url;
    }).catch(() => { if (alive) setError('源图加载失败'); });
    return () => { alive = false; };
  }, [projectId, sourceAssetId]);

  function point(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (event.currentTarget.width / rect.width),
      y: (event.clientY - rect.top) * (event.currentTarget.height / rect.height),
    };
  }

  function paint(from: Point | null, to: Point) {
    const ctx = maskRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = brush;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (from) {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    } else {
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x + 0.01, to.y);
    }
    ctx.stroke();
    if (!from) {
      ctx.beginPath();
      ctx.arc(to.x, to.y, brush / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    render();
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!ready) return;
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = point(event);
    paint(null, at);
    lastRef.current = at;
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const at = point(event);
    paint(lastRef.current, at);
    lastRef.current = at;
  }

  function onPointerUp() {
    drawingRef.current = false;
    lastRef.current = null;
    setCoverage(currentCoverage());
  }

  function clearMask() {
    const mask = maskRef.current;
    mask?.getContext('2d')?.clearRect(0, 0, mask.width, mask.height);
    setCoverage(0);
    render();
  }

  /** 画过的像素比例：空蒙版提交上去只会白花钱，必须拦住。 */
  function paintedRatio(mask: HTMLCanvasElement): number {
    const ctx = mask.getContext('2d');
    if (!ctx) return 0;
    return maskPaintedRatio(ctx.getImageData(0, 0, mask.width, mask.height).data);
  }

  /** 已涂区域占全图的比例（百分比）。 */
  function currentCoverage(): number {
    const mask = maskRef.current;
    if (!mask || !mask.width || !mask.height) return 0;
    return Math.round(paintedRatio(mask) * 100);
  }

  async function save() {
    const mask = maskRef.current;
    if (!mask || saving) return;
    if (paintedRatio(mask) === 0) {
      setError('请先涂抹要重绘的区域');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const asset = await saveMask(mask.toDataURL('image/png'), sourceAssetId, nodeId, projectId);
      onSaved(asset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="mask-dialog" role="dialog" aria-label="局部重绘蒙版">
        <header className="mask-dialog-head">
          <div>
            <span className="studio-eyebrow">局部重绘</span>
            <h2>绘制重绘蒙版</h2>
          </div>
          <button type="button" title="关闭" onClick={onClose}><X size={14} /></button>
        </header>
        <p className="inspector-note">在源图上涂抹要重绘的区域（半透明白色）；其余部分会保持原样。橡皮可以擦掉画错的地方。</p>
        <div className="mask-tools">
          <button
            type="button"
            className={tool === 'brush' ? 'active' : ''}
            onClick={() => setTool('brush')}
          ><Paintbrush size={12} /> 画笔</button>
          <button
            type="button"
            className={tool === 'eraser' ? 'active' : ''}
            onClick={() => setTool('eraser')}
          ><Eraser size={12} /> 橡皮</button>
          <label>
            笔刷 {brush}px
            <input type="range" min={8} max={200} value={brush} onChange={(event) => setBrush(Number(event.target.value))} />
          </label>
          <button type="button" onClick={clearMask}><Trash2 size={12} /> 清空</button>
          <span className="mask-coverage">已涂 {coverage}%</span>
        </div>
        <div className="mask-stage">
          <canvas
            ref={displayRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {!ready && <p className="mask-stage-note">{error || '正在加载源图…'}</p>}
        </div>
        {error && ready && <p className="inspector-warning">{error}</p>}
        <footer className="mask-dialog-foot">
          <button type="button" className="studio-button secondary" onClick={onClose}>取消</button>
          <button type="button" className="studio-button" disabled={!ready || saving} onClick={() => void save()}>
            <Save size={12} /> {saving ? '保存中…' : '保存蒙版'}
          </button>
        </footer>
      </div>
    </div>
  );
}
