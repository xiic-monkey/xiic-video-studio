import { Component, type ReactNode } from 'react';
import { pushToast } from '../ui/toast';

interface State {
  error?: Error;
  info?: string;
  /** 已尝试的重试次数，用于限制自动重试，避免错误状态下无限循环。 */
  attempts: number;
}

/** 自动重试上限：超过后只允许手动重载。 */
const MAX_AUTO_RETRY = 2;

/**
 * 渲染期错误兜底：没有它时任何子组件抛错都会让整棵 React 树卸载成白屏，
 * 且真实报错只出现在 DevTools 里。这里把错误直接画在页面上，便于定位。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { attempts: 0 };

  // 只覆盖 error，保留 attempts 计数；否则永久错误每次重试都会把计数清零，形成死循环。
  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[frameforge] 渲染错误', error, info.componentStack);
    const attempts = this.state.attempts + 1;
    this.setState({ attempts, info: info.componentStack });
    // 偶发的渲染错误（例如读到了半就绪的数据）自愈，不必让用户手动刷新；
    // 永久错误重试到上限后就停在崩溃页，避免无限重试。
    if (attempts <= MAX_AUTO_RETRY) {
      setTimeout(() => {
        this.setState({ error: undefined, info: undefined });
      }, 0);
    }
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-overlay" role="alert">
        <h1>界面崩溃（不是白屏，是渲染报错）</h1>
        <p>把下面的报错信息发给开发即可定位。可点「重新加载」继续使用。</p>
        <pre>{error.message}</pre>
        <pre>{error.stack}</pre>
        {info && <pre>{info}</pre>}
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </div>
    );
  }
}

/**
 * 非渲染期的全局错误（事件处理、异步 Promise）也显示成提示，不再无声消失。
 *
 * 走统一的悬浮提示：右下角浮出、十几秒后自己收走。
 * 之前这里挂的是一块永不消失的红底框，错误早就过去了它还占着屏幕。
 */
export function installGlobalErrorOverlay() {
  const show = (title: string, detail: string) => {
    pushToast({ title, detail, tone: 'error', duration: 12000 });
  };
  window.addEventListener('error', (event) => {
    console.error('[frameforge] 运行错误', event.error);
    show('运行错误', event.error instanceof Error ? event.error.message : String(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[frameforge] 未处理的异步错误', event.reason);
    show('未处理的异步错误', event.reason instanceof Error ? event.reason.message : String(event.reason));
  });
}
