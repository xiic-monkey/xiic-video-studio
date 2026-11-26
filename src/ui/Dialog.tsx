import { useEffect, useRef } from 'react';

interface DialogProps {
  open: boolean;
  /** Esc 与遮罩点击时触发。 */
  onClose(): void;
  /** 点击遮罩是否关闭。破坏性确认框传 false，避免误点丢数据。 */
  closeOnBackdrop?: boolean;
  label: string;
  className?: string;
  /** 居中弹窗（默认）或左侧抽屉。抽屉用于素材库这类贴边展开的面板。 */
  placement?: 'center' | 'left';
  children: React.ReactNode;
}

/**
 * 应用内弹窗外壳。
 *
 * 统一处理三件以前分散在各对话框里的事：
 * - Esc 关闭
 * - 点击遮罩关闭（可按需关闭）
 * - 焦点陷阱：Tab 不会跑到背景内容上，关闭后焦点回到触发元素
 */
export function Dialog({ open, onClose, closeOnBackdrop = true, label, className, placement = 'center', children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const panelClass = [className ?? 'dialog-panel', placement === 'left' ? 'is-left' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={`dialog-backdrop ${placement === 'left' ? 'is-left' : ''}`}
      onMouseDown={(event) => {
        if (!closeOnBackdrop) return;
        if (event.target !== event.currentTarget) return;
        onClose();
      }}
    >
      <div
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={panelRef}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
