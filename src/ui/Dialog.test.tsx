// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from './Dialog';

afterEach(cleanup);

/**
 * 共享 Dialog 负责三件以前分散实现的事：Esc 关闭、点遮罩关闭、焦点陷阱。
 * 焦点陷阱最容易在重构时退化（Tab 跑到背景内容上），所以单独立测试。
 */
describe('Dialog', () => {
  it('打开时把焦点移进面板', () => {
    render(
      <Dialog open onClose={() => undefined} label="测试">
        <button type="button">第一个</button>
        <button type="button">第二个</button>
      </Dialog>,
    );
    const panel = screen.getByLabelText('测试');
    expect(document.activeElement).toBe(panel);
  });

  it('Esc 触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="测试">
        <button type="button">按钮</button>
      </Dialog>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab 在最后一个可聚焦元素处回到第一个', () => {
    render(
      <Dialog open onClose={() => undefined} label="测试">
        <button type="button">第一个</button>
        <button type="button">第二个</button>
      </Dialog>,
    );
    const [first, second] = Array.from(screen.getAllByRole('button')) as HTMLButtonElement[];
    second.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab 在第一个可聚焦元素处回到最后一个', () => {
    render(
      <Dialog open onClose={() => undefined} label="测试">
        <button type="button">第一个</button>
        <button type="button">第二个</button>
      </Dialog>,
    );
    const [first, second] = Array.from(screen.getAllByRole('button')) as HTMLButtonElement[];
    first.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(second);
  });

  it('点遮罩关闭，点面板内部不关闭', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="测试">
        <button type="button">按钮</button>
      </Dialog>,
    );
    const backdrop = document.querySelector('.dialog-backdrop') as HTMLElement;
    fireEvent.mouseDown(screen.getByLabelText('测试'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnBackdrop=false 时点遮罩不关闭', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} closeOnBackdrop={false} label="测试">
        <button type="button">按钮</button>
      </Dialog>,
    );
    const backdrop = document.querySelector('.dialog-backdrop') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('open=false 时不渲染', () => {
    const { container } = render(
      <Dialog open={false} onClose={() => undefined} label="测试">
        <button type="button">按钮</button>
      </Dialog>,
    );
    expect(container.querySelector('.dialog-backdrop')).toBeNull();
  });

  it('placement=left 时渲染成左侧抽屉', () => {
    const { container } = render(
      <Dialog open onClose={() => undefined} label="资产库" placement="left" className="asset-drawer">
        <button type="button">按钮</button>
      </Dialog>,
    );
    expect(container.querySelector('.dialog-backdrop.is-left')).not.toBeNull();
    expect(container.querySelector('.asset-drawer.is-left')).not.toBeNull();
  });
});
