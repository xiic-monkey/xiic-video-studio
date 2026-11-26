import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useBoardStore } from '../stores/boardStore';

/**
 * 关窗前把画布落库。
 *
 * 画布保存是 700ms 防抖的：用户改完最后一笔立刻关窗，那 700ms 里的改动
 * 会随窗口一起消失。这里在 Tauri 的关闭请求里先 await 一次 flush，
 * 落库失败时取消关闭，让用户有机会重试，而不是静默丢数据。
 */
export function useFlushOnClose(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
      try {
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (disposed) return;
          const state = useBoardStore.getState();
          if (!state.dirty || !state.board) return;
          event.preventDefault();
          await state.flush();
          // flush 后仍有未保存内容（例如保存失败）：保持窗口打开，让用户看到错误。
          if (useBoardStore.getState().dirty) return;
          await appWindow.destroy();
        });
      } catch {
        // 非桌面环境或窗口 API 不可用：静默降级，不影响正常使用。
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
