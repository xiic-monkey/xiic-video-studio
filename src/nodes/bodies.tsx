import { useState, type ReactElement } from 'react';
import type { AssetRef, BoardNode, RunRecord } from '../domain/types';
import { importMedia } from '../services/tauri';
import { useAssetStore } from '../stores/assetStore';
import { useBoardStore } from '../stores/boardStore';
import { useStudioStore } from '../stores/studioStore';
import { AssetPickerDialog } from '../ui/AssetPickerDialog';
import { sourceNodeKindFor } from '../domain/nodes/definitions';
import { modeLabel, outputAssetId, statusOf, summarizeNode } from './summary';
import { useAssetUrl } from './useAssetUrl';

interface BodyProps {
  node: BoardNode;
  run?: RunRecord;
}

function Meta({ items }: { items: Array<string | undefined | false> }) {
  const visible = items.filter(Boolean) as string[];
  if (!visible.length) return null;
  return (
    <div className="flow-meta">
      {visible.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
    </div>
  );
}

export function TextBody({ node }: BodyProps) {
  return (
    <div className="flow-body">
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[modeLabel(node.data.mode)]} />
    </div>
  );
}

export function ImageBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  return (
    <div className="flow-body">
      {url
        ? <img className="flow-media flow-media-image" src={url} alt="" draggable={false} />
        : <div className="flow-media flow-media-empty"><span>暂无图片</span></div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[
        String(node.data.size ?? ''),
        `${Number(node.data.count ?? 1)} 张候选`,
        run?.status === 'running' ? `${statusOf(run).label}…` : undefined,
      ]} />
    </div>
  );
}

export function VideoBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  return (
    <div className="flow-body">
      {url
        ? <video className="flow-media" src={url} muted playsInline preload="metadata" />
        : <div className="flow-media flow-media-empty"><span>暂无视频</span></div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[
        modeLabel(node.data.mode),
        `${Number(node.data.duration ?? 0)}s`,
        String(node.data.resolution ?? ''),
        String(node.data.aspectRatio ?? ''),
      ]} />
    </div>
  );
}

export function AudioBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  const text = String(node.data.text ?? '');
  const bars = Array.from({ length: 28 }, (_, index) => {
    const code = text.charCodeAt(index % Math.max(text.length, 1)) || 58;
    return 18 + (code % 62);
  });
  return (
    <div className="flow-body">
      {url
        ? <audio className="flow-audio nodrag" src={url} controls preload="metadata" />
        : (
          // 这不是真实音频波形：没有产物时按文本字符码生成的示意条。
          // 标注清楚，免得被当成真实波形读。
          <div className="flow-wave">
            {bars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}
            <span className="flow-wave-note">示意</span>
          </div>
        )}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[String(node.data.voice ?? ''), String(node.data.format ?? '').toUpperCase()]} />
    </div>
  );
}

export function ScriptBody({ node }: BodyProps) {
  const body = String(node.data.body ?? '');
  const lines = body.split(/\n+/).filter((line) => line.trim()).length;
  const beats = String(node.data.beats ?? '').split(/\n+/).filter((line) => line.trim()).length;
  const preview = body.replace(/\s+/g, ' ').trim();
  return (
    <div className="flow-body">
      <p className="flow-title">{String(node.data.title ?? '').trim() || '未命名剧本'}</p>
      <p className="flow-quote">{preview ? (preview.length > 120 ? `${preview.slice(0, 120)}…` : preview) : '正文为空'}</p>
      <Meta items={[`${lines} 段`, beats ? `${beats} 个节拍` : undefined]} />
    </div>
  );
}

export function NoteBody({ node }: BodyProps) {
  return (
    <div className={`flow-body flow-note flow-note-${String(node.data.color ?? 'default')}`}>
      <p className="flow-quote">{summarizeNode(node, 140)}</p>
    </div>
  );
}

export function GroupBody({ node }: BodyProps) {
  return (
    <div className="flow-body flow-group-body">
      <p className="flow-title">{String(node.data.label ?? '').trim() || '分组'}</p>
      <Meta items={['框选节点后 Cmd/Ctrl+G 编组']} />
    </div>
  );
}

/* ---------- 业务节点：局部枚举 → 中文 ---------- */

/** 角色三视图版式。 */
const LAYOUT_LABEL: Record<string, string> = {
  landscape: '横版', portrait: '竖版',
};

/** 角色三视图背景。 */
const BACKGROUND_LABEL: Record<string, string> = {
  white: '纯白', gray: '浅灰',
};

/** 宫格规格。 */
const GRID_LABEL: Record<string, string> = {
  '3x3': '3×3', '4x4': '4×4',
};

/** 分镜宫格格数。 */
const GRID_CELLS: Record<string, string> = {
  '3x3': '9 格', '4x4': '16 格',
};

/** 多机位机位数。 */
const COVERAGE_CELLS: Record<string, string> = {
  '3x3': '9 机位', '4x4': '16 机位',
};

/** 表情组。 */
const EXPRESSION_LABEL: Record<string, string> = {
  happy: '基础九种', dramatic: '戏剧九种', calm: '克制九种',
};

/** 造型变体类型。 */
const VARIANT_LABEL: Record<string, string> = {
  outfit: '服装', age: '年龄', battle: '战损', makeup: '妆造',
};

/** 剧情推演方向。 */
const CONTINUITY_LABEL: Record<string, string> = {
  'before-after': '前3秒/当前/后3秒', sequence: '前序/过程/后续/结果',
};

/** 截断长文本，用于元信息里的一句话摘要（元信息是等宽小字，不能太长）。 */
function brief(value: unknown, max = 14): string | undefined {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 图片产物型业务节点的通用骨架。
 *
 * 这些节点（角色/分镜/表情/变体/转面/机位/推演/改图/重绘）产出的都是一张图，
 * 差别只在版式参数，所以共用「缩略图 + 提示词摘要 + 版式元信息」三段结构。
 */
function ArtifactBody({ node, run, emptyText, meta }: {
  node: BoardNode;
  run?: RunRecord;
  emptyText: string;
  meta: Array<string | undefined | false>;
}) {
  const url = useAssetUrl(outputAssetId(run));
  return (
    <div className="flow-body">
      {url
        ? <img className="flow-media flow-media-image" src={url} alt="" draggable={false} />
        : <div className="flow-media flow-media-empty"><span>{emptyText}</span></div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[
        ...meta,
        run?.status === 'running' ? `${statusOf(run).label}…` : undefined,
      ]} />
    </div>
  );
}

/** 角色三视图：产物缩略图 + 版式与背景。 */
export function CharacterBody({ node, run }: BodyProps) {
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无三视图"
      meta={[
        LAYOUT_LABEL[String(node.data.layout ?? '')],
        BACKGROUND_LABEL[String(node.data.background ?? '')],
      ]}
    />
  );
}

/** 分镜九宫格：产物缩略图 + 宫格规格。 */
export function StoryboardBody({ node, run }: BodyProps) {
  const grid = String(node.data.grid ?? '');
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无分镜图"
      meta={[GRID_LABEL[grid], GRID_CELLS[grid]]}
    />
  );
}

/** 表情九宫格：产物缩略图 + 表情组。 */
export function ExpressionBody({ node, run }: BodyProps) {
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无表情图"
      meta={[EXPRESSION_LABEL[String(node.data.variant ?? '')]]}
    />
  );
}

/** 造型变体：产物缩略图 + 变体类型与变体要求。 */
export function VariantBody({ node, run }: BodyProps) {
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无变体图"
      meta={[
        VARIANT_LABEL[String(node.data.variant ?? '')],
        brief(node.data.note),
      ]}
    />
  );
}

/** 360 转面：产物缩略图 + 方向数。 */
export function TurnaroundBody({ node, run }: BodyProps) {
  const steps = Number(node.data.steps ?? 0);
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无转面图"
      meta={[steps > 0 ? `${steps} 方向` : undefined]}
    />
  );
}

/** 场景多机位：产物缩略图 + 宫格与机位数。 */
export function CoverageBody({ node, run }: BodyProps) {
  const grid = String(node.data.grid ?? '');
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无机位图"
      meta={[GRID_LABEL[grid], COVERAGE_CELLS[grid]]}
    />
  );
}

/** 剧情推演：产物缩略图 + 推演方向。 */
export function ContinuityBody({ node, run }: BodyProps) {
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无推演图"
      meta={[CONTINUITY_LABEL[String(node.data.variant ?? '')]]}
    />
  );
}

/** 重绘 / 改图：产物缩略图 + 修改要求摘要。 */
export function RedrawBody({ node, run }: BodyProps) {
  const note = brief(node.data.note);
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无改图结果"
      meta={[note ? `要求：${note}` : undefined]}
    />
  );
}

/** 局部重绘：产物缩略图 + 蒙版是否就绪。 */
export function InpaintBody({ node, run }: BodyProps) {
  const maskAssetId = String(node.data.maskAssetId ?? '').trim();
  return (
    <ArtifactBody
      node={node}
      run={run}
      emptyText="暂无重绘结果"
      meta={[maskAssetId ? '蒙版已就绪' : '未绘制蒙版']}
    />
  );
}

/**
 * 文本素材节点体：手写的常量文本。
 *
 * 不跑模型，写下的就是输出；正文直接显示在节点上，编辑在右侧面板。
 */
export function TextSourceBody({ node }: BodyProps) {
  const text = String(node.data.text ?? '').trim();
  const note = String(node.data.note ?? '').trim();
  return (
    <div className="flow-body">
      {text
        ? <p className="flow-quote flow-text-source">{text}</p>
        : <div className="flow-media flow-media-empty"><span>还没有文本</span></div>}
      <Meta items={[note || undefined]} />
    </div>
  );
}

/**
 * 素材节点体：图片 / 视频 / 音频共用。
 *
 * 只输出、不输入——和 ComfyUI 的 Load Image 一个角色：
 * 选一段素材（或从桌面拖进来），把它连给下游的参考端口。
 * 节点体上直接给两个入口，避免用户还要先去资产库翻。
 */
export function SourceBody({ node }: BodyProps) {
  const kind = (sourceNodeKindFor(node.type) ?? 'image') as 'image' | 'video' | 'audio';
  const assetId = String(node.data.assetId ?? '').trim();
  const name = String(node.data.displayName ?? '').trim();
  const url = useAssetUrl(assetId || undefined);
  const projectId = useStudioStore((state) => state.currentProjectId);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();

  const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';

  function setAsset(asset: AssetRef) {
    useBoardStore.getState().apply({
      type: 'setNodeData',
      nodeId: node.id,
      patch: { assetId: asset.id, displayName: asset.provenance.displayName ?? asset.id },
    });
  }

  async function importLocal() {
    if (!projectId || importing) return;
    setImporting(true);
    setError(undefined);
    try {
      const task = await importMedia(projectId);
      const imported = Array.isArray(task?.payload?.importedAssetIds)
        ? (task.payload.importedAssetIds as string[])
        : [];
      if (!imported.length) return;
      const assets = useAssetStore.getState().assets;
      const asset = assets.find((item) => item.id === imported[0]);
      setAsset(asset ?? { id: imported[0], provenance: { projectId } } as AssetRef);
      await useAssetStore.getState().refresh();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setImporting(false);
    }
  }


  return (
    <div className="flow-body">
      {url
        ? (kind === 'image'
          ? <img className="flow-media flow-media-image" src={url} alt="" draggable={false} />
          : kind === 'video'
            ? <video className="flow-media" src={url} muted playsInline preload="metadata" />
            : <audio className="flow-audio nodrag" src={url} controls preload="metadata" />)
        : (
          <div className="flow-media flow-media-empty">
            <span>还没有{label}</span>
            <span className="inspector-note">把{label}拖到画布上，或在这里选一个</span>
          </div>
        )}
      <div className="flow-source-actions nodrag">
        <button type="button" className="studio-button secondary" onClick={() => setPicking(true)}>从资产库选</button>
        <button type="button" className="studio-button secondary" disabled={!projectId || importing} onClick={() => void importLocal()}>
          {importing ? '导入中…' : `导入本地${label}`}
        </button>
      </div>
      {error && <p className="inspector-note">{error}</p>}
      <Meta items={[name || undefined]} />
      <AssetPickerDialog
        open={picking}
        projectId={projectId}
        kind={kind}
        title={`选择${label}`}
        onClose={() => setPicking(false)}
        onPick={setAsset}
      />
    </div>
  );
}

export type NodeBody = (props: BodyProps) => ReactElement;

export const BODIES: Record<string, NodeBody> = {
  text: TextBody,
  image: ImageBody,
  video: VideoBody,
  audio: AudioBody,
  script: ScriptBody,
  note: NoteBody,
  group: GroupBody,
  character: CharacterBody,
  storyboard: StoryboardBody,
  expression: ExpressionBody,
  variant: VariantBody,
  turnaround: TurnaroundBody,
  coverage: CoverageBody,
  continuity: ContinuityBody,
  redraw: RedrawBody,
  inpaint: InpaintBody,
  image_source: SourceBody,
  text_source: TextSourceBody,
  video_source: SourceBody,
  audio_source: SourceBody,
};
