import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useToastStore, type Toast } from './toast';

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((state) => state.dismiss);
  const [paused, setPaused] = useState(false);

  // 鼠标悬停时暂停倒计时：用户正在读或正准备点按钮时不该被收走。
  useEffect(() => {
    if (paused || !toast.duration) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, dismiss, paused]);

  return (
    <div
      className={`toast toast-${toast.tone}`}
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="toast-body">
        <b>{toast.title}</b>
        {toast.detail && <span>{toast.detail}</span>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.onClick();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => dismiss(toast.id)}>
        <X size={13} />
      </button>
    </div>
  );
}

/**
 * 全局悬浮提示。
 *
 * 临时性的消息（保存失败、导入结果）都走这里：右下角浮出，几秒后自动消失，
 * 悬停时停住不走。顶栏只留「保存中 / 有未保存改动 / 已保存」这种状态，
 * 错误详情不该占着顶栏常驻。
 */
export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} />)}
    </div>
  );
}
