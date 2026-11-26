import { useCallback } from 'react';
import { Dialog } from './Dialog';
import { useConfirmStore } from './confirmStore';

/**
 * 全局确认框宿主。
 *
 * 挂在应用壳上：`confirmAction()` 是个纯函数式调用，任何组件都能触发，
 * 不必把确认状态一层层往下传。
 */
export function ConfirmHost() {
  const request = useConfirmStore((state) => state.request);
  const settle = useConfirmStore((state) => state.settle);

  // 必须稳定引用：Dialog 的焦点管理依赖 onClose 的身份，
  // 每次渲染都换一个新函数会让焦点在弹窗内外来回跳，输入框就写不进字了。
  const close = useCallback(() => settle(false), [settle]);

  return (
    <Dialog
      open={Boolean(request)}
      onClose={close}
      closeOnBackdrop={request?.tone !== 'danger'}
      label={request?.title ?? '确认'}
      className="confirm-dialog-panel"
    >
      {request && (
        <>
          <header>
            <h2>{request.title}</h2>
            {request.message && <p className="confirm-sub">{request.message}</p>}
          </header>
          {request.detail && <p className="confirm-detail">{request.detail}</p>}
          <footer className="confirm-actions">
            <button type="button" className="studio-button secondary" onClick={() => settle(false)}>
              {request.cancelText ?? '取消'}
            </button>
            <button
              type="button"
              className={request.tone === 'danger' ? 'studio-button danger' : 'studio-button'}
              onClick={() => settle(true)}
            >
              {request.confirmText ?? '确认'}
            </button>
          </footer>
        </>
      )}
    </Dialog>
  );
}
