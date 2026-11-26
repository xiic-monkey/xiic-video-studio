import { create } from 'zustand';

export interface ConfirmOptions {
  title: string;
  /** 正文，可多段。 */
  message?: string;
  /** 补充说明（路径、影响范围等），用次级样式展示。 */
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  /** danger 用于不可逆操作（删除、覆盖）。 */
  tone?: 'default' | 'danger';
}

interface ConfirmRequest extends ConfirmOptions {
  resolve(confirmed: boolean): void;
}

interface ConfirmState {
  request?: ConfirmRequest;
  ask(options: ConfirmOptions): Promise<boolean>;
  settle(confirmed: boolean): void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: undefined,

  ask(options) {
    // 同时只允许一个确认框：后来的请求直接复用同一个 Promise 语义，
    // 不排队，避免旧确认框挡住新流程。
    return new Promise<boolean>((resolve) => {
      set({ request: { ...options, resolve } });
    });
  },

  settle(confirmed) {
    const request = get().request;
    if (!request) return;
    set({ request: undefined });
    request.resolve(confirmed);
  },
}));

/**
 * 弹一个应用内确认框。
 *
 * 替代 `window.confirm`：原生弹窗不跟随应用样式、没有焦点管理，
 * 在 Tauri 里还会阻塞整个 WebView。
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().ask(options);
}
