// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastHost } from './ToastHost';
import { useToastStore } from './toast';

afterEach(() => {
  cleanup();
  useToastStore.getState().clear();
  vi.useRealTimers();
});

describe('ToastHost', () => {
  it('几秒后自动消失', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => {
      useToastStore.getState().push({ title: '保存失败', detail: '画布修订冲突', tone: 'error' });
    });
    expect(screen.getByText('保存失败')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText('保存失败')).toBeNull();
  });

  it('鼠标悬停时停住不走', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => {
      useToastStore.getState().push({ title: '保存失败', tone: 'error' });
    });
    const toast = screen.getByRole('status');
    act(() => { vi.advanceTimersByTime(3000); });
    fireEvent.mouseEnter(toast);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.queryByText('保存失败')).not.toBeNull();

    // 移开鼠标后重新计时，几秒后自动收走。
    fireEvent.mouseLeave(toast);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText('保存失败')).toBeNull();
  });

  it('点按钮会执行动作并关闭提示', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(<ToastHost />);
    act(() => {
      useToastStore.getState().push({ title: '保存失败', tone: 'error', action: { label: '重试保存', onClick } });
    });
    fireEvent.click(screen.getByText('重试保存'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('保存失败')).toBeNull();
  });

  it('同标题的提示只保留最新一条', () => {
    render(<ToastHost />);
    act(() => {
      useToastStore.getState().push({ title: '保存失败', detail: '第一次' });
      useToastStore.getState().push({ title: '保存失败', detail: '第二次' });
    });
    expect(screen.queryByText('第一次')).toBeNull();
    expect(screen.getByText('第二次')).toBeTruthy();
  });
});
