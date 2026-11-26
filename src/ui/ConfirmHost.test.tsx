// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmHost } from './ConfirmHost';
import { confirmAction, useConfirmStore } from './confirmStore';

// 确认框是全局宿主：每个用例渲染一个，不清理会互相串状态。
afterEach(cleanup);

/**
 * 应用内确认框替代原生 window.confirm。
 * 这里验证三件事：确认/取消的返回值、危险态不允许点遮罩关闭、Esc 等于取消。
 */
describe('ConfirmHost', () => {
  it('确认后 resolve(true)', async () => {
    render(<ConfirmHost />);
    let promise!: Promise<boolean>;
    act(() => { promise = confirmAction({ title: '删除画布', message: '确定吗？' }); });
    expect(screen.getByText('删除画布')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await expect(promise).resolves.toBe(true);
  });

  it('取消后 resolve(false)', async () => {
    render(<ConfirmHost />);
    let promise!: Promise<boolean>;
    act(() => { promise = confirmAction({ title: '删除画布', message: '确定吗？' }); });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await expect(promise).resolves.toBe(false);
  });

  it('危险操作点遮罩不关闭，避免误触丢数据', async () => {
    render(<ConfirmHost />);
    let promise!: Promise<boolean>;
    act(() => { promise = confirmAction({ title: '删除项目', tone: 'danger' }); });
    const backdrop = document.querySelector('.dialog-backdrop') as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.mouseDown(backdrop);
    // 遮罩点击后确认框仍在，等待确认的 Promise 也没有被结算。
    expect(screen.getByText('删除项目')).toBeTruthy();
    act(() => { useConfirmStore.getState().settle(false); });
    await expect(promise).resolves.toBe(false);
  });

  it('普通操作点遮罩即取消', async () => {
    render(<ConfirmHost />);
    let promise!: Promise<boolean>;
    act(() => { promise = confirmAction({ title: '导出 MP4' }); });
    const backdrop = document.querySelector('.dialog-backdrop') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    await expect(promise).resolves.toBe(false);
  });

  it('Esc 等于取消', async () => {
    render(<ConfirmHost />);
    let promise!: Promise<boolean>;
    act(() => { promise = confirmAction({ title: '导出 MP4' }); });
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(promise).resolves.toBe(false);
  });

  it('没有待确认请求时不渲染任何东西', () => {
    const { container } = render(<ConfirmHost />);
    expect(container.querySelector('.dialog-backdrop')).toBeNull();
  });
});
