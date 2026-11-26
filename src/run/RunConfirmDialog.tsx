import { useEffect, useRef } from 'react';
import type { RunRequestDraft } from '../domain/run/prepare';
import { Dialog } from '../ui/Dialog';
import { useRunController } from './controller';

const CAPABILITY_LABEL: Record<string, string> = {
  'text.chat': '文本生成',
  'image.generate': '图片生成',
  'image.edit': '图片编辑',
  'video.generate': '视频生成',
  'audio.tts': '语音合成',
};

const MODE_LABEL: Record<string, string> = { t2v: '文生视频', firstLast: '首尾帧', reference: '全能参考' };

function paramLines(request: RunRequestDraft): string[] {
  const params = request.params;
  switch (request.capability) {
    case 'video.generate':
      return [
        `${MODE_LABEL[String(params.mode ?? '')] ?? String(params.mode ?? '')} · ${String(params.duration ?? '')} 秒 · ${String(params.resolution ?? '')} · ${String(params.ratio ?? '')}`,
        params.generateAudio ? '包含原生音频' : '不生成音频',
      ];
    case 'image.generate':
    case 'image.edit':
      return [`候选 ${String(params.count ?? 1)} 张 · ${String(params.size ?? '')}`];
    case 'audio.tts':
      return [`音色 ${String(params.voice ?? '')} · ${String(params.format ?? '')} · ${[...String(params.text ?? '')].length} 字符`];
    case 'text.chat':
      return [params.system ? '带系统提示' : '无系统提示'];
    default:
      return [];
  }
}

export function RunConfirmDialog() {
  const pending = useRunController((state) => state.pending);
  const confirmRun = useRunController((state) => state.confirmRun);
  const dismissRun = useRunController((state) => state.dismissRun);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      // Enter 只允许在确认框内部生效，背景按钮不得被再次触发（否则会重复发起运行）。
      const target = event.target as Node | null;
      if (target && bodyRef.current?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pending, dismissRun]);

  return (
    <Dialog
      open={Boolean(pending)}
      onClose={dismissRun}
      closeOnBackdrop={false}
      label="运行确认"
      className="confirm-dialog"
    >
      {pending && (
        <div ref={bodyRef}>
          <header>
            <h2>运行「{pending.label.nodeTitle}」</h2>
            <p className="confirm-sub">这次会真实调用模型并产生费用。</p>
          </header>
          <dl className="confirm-body">
            <div><dt>能力</dt><dd>{CAPABILITY_LABEL[pending.request.capability] ?? pending.request.capability}</dd></div>
            <div><dt>模型</dt><dd>{pending.label.providerName} · {pending.label.modelName}</dd></div>
            <div><dt>参数</dt><dd>{paramLines(pending.request).join(' · ') || '默认'}</dd></div>
            <div><dt>提示词</dt><dd className="confirm-prompt">{pending.request.promptSnapshot.text}</dd></div>
            <div><dt>素材输入</dt><dd>{pending.inputCount ? `${pending.inputCount} 个` : '无'}</dd></div>
            <div><dt>预计费用</dt><dd>
              {pending.cost
                ? `${pending.cost.currency} ${pending.cost.amount} / ${pending.cost.unit}`
                : '未配置价格，无法估算；按实际用量计费'}
            </dd></div>
          </dl>
          {!!pending.warnings.length && (
            <ul className="confirm-warnings">
              {pending.warnings.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}
            </ul>
          )}
          <footer className="confirm-actions">
            <button type="button" className="studio-button secondary" onClick={dismissRun}>取消</button>
            <button type="button" className="studio-button" onClick={() => void confirmRun()}>确认运行</button>
          </footer>
        </div>
      )}
    </Dialog>
  );
}
