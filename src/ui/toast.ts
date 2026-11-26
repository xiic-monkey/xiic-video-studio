import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface Toast {
  id: string;
  title: string;
  detail?: string;
  tone: ToastTone;
  action?: ToastAction;
  /** 自动消失时间（毫秒）。0 表示常驻。 */
  duration: number;
}

export interface ToastInput {
  title: string;
  detail?: string;
  tone?: ToastTone;
  action?: ToastAction;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  push(input: ToastInput): string;
  dismiss(id: string): void;
  clear(): void;
}

let counter = 0;

/** 无操作的提示停留 6 秒；带按钮的留 10 秒，够用户点一下。 */
const DEFAULT_DURATION = 6000;
const ACTION_DURATION = 10000;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push(input) {
    counter += 1;
    const toast: Toast = {
      id: `toast_${counter}`,
      title: input.title,
      detail: input.detail,
      tone: input.tone ?? 'info',
      action: input.action,
      duration: input.duration ?? (input.action ? ACTION_DURATION : DEFAULT_DURATION),
    };
    set((state) => ({
      // 同标题只留最新一条：同一个错误反复触发时不堆成一摞。
      toasts: [...state.toasts.filter((item) => item.title !== toast.title), toast],
    }));
    return toast.id;
  },

  dismiss(id) {
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  },

  clear() {
    set({ toasts: [] });
  },
}));

/** 在组件之外发提示（store、事件回调里用）。 */
export function pushToast(input: ToastInput): string {
  return useToastStore.getState().push(input);
}
