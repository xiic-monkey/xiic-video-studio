import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * ErrorBoundary 是 class 组件，没有 DOM 环境时直接验证它的状态机：
 * 捕获错误后自动重试恢复，且重试次数有上限，永久错误不会无限循环。
 */
function makeBoundary() {
  const boundary = new ErrorBoundary({ children: '正常内容' });
  // class 组件的 setState 在未挂载时是空实现，这里替换成同步写入以便断言状态。
  boundary.setState = ((patch: unknown) => {
    const next = typeof patch === 'function'
      ? (patch as (s: unknown) => unknown)(boundary.state)
      : patch;
    boundary.state = { ...boundary.state, ...(next as object) };
    return undefined;
  }) as typeof boundary.setState;
  return boundary;
}

describe('ErrorBoundary', () => {
  it('未出错时直接渲染子树', () => {
    const boundary = new ErrorBoundary({ children: '正常内容' });
    expect(boundary.render()).toBe('正常内容');
  });

  it('捕获错误后展示崩溃页而不是抛给上层', () => {
    const boundary = makeBoundary();
    const error = new Error('渲染炸了');
    const next = ErrorBoundary.getDerivedStateFromError(error);
    expect(next.error).toBe(error);
    // 计数必须保留，否则永久错误会无限重试。
    expect(next.attempts).toBeUndefined();
  });

  it('自动重试会清空错误状态恢复渲染', async () => {
    vi.useFakeTimers();
    const boundary = makeBoundary();
    const error = new Error('渲染炸了');
    boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(error) };
    expect(boundary.state.error).toBe(error);

    boundary.componentDidCatch(error, {});
    expect(boundary.state.attempts).toBe(1);

    await vi.runAllTimersAsync();
    expect(boundary.state.error).toBeUndefined();
    expect(boundary.render()).toBe('正常内容');
    vi.useRealTimers();
  });

  it('重试达到上限后不再自动恢复，停在崩溃页', async () => {
    vi.useFakeTimers();
    const boundary = makeBoundary();
    const error = new Error('渲染炸了');
    boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(error) };

    // 连续捕获三次：前两次会自愈，第三次达到上限。
    boundary.componentDidCatch(error, {});
    await vi.runAllTimersAsync();
    boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(error) };
    boundary.componentDidCatch(error, {});
    await vi.runAllTimersAsync();
    boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(error) };
    boundary.componentDidCatch(error, {});
    await vi.runAllTimersAsync();

    expect(boundary.state.attempts).toBe(3);
    // 达到上限后错误状态保留，界面停在崩溃页而不是无限重试。
    expect(boundary.state.error).toBe(error);
    vi.useRealTimers();
  });
});
