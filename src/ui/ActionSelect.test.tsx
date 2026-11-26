// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActionSelect } from './ActionSelect';

// 每个用例渲染一个新组件：不清���的话后一个用例会找到上一个用例留下的节点。
afterEach(cleanup);

/**
 * ActionSelect 修的是「动作型下拉选完一次后，再选同一个素材不触发」的问题。
 * 这个 bug 只有在真实 DOM 里才能复现，所以这里用 jsdom 渲染组件验证。
 */
describe('ActionSelect', () => {
  const options = [
    { value: 'a1', label: '素材一' },
    { value: 'a2', label: '素材二' },
  ];

  it('选中一项后触发一次 onPick', () => {
    const onPick = vi.fn();
    render(<ActionSelect label="选择视频" placeholder="选择视频" options={options} onPick={onPick} />);
    const select = screen.getByLabelText('选择视频') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'a1' } });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('a1');
  });

  it('选完后回到占位项，同一个素材可以再次触发', () => {
    const onPick = vi.fn();
    render(<ActionSelect label="选择视频" placeholder="选择视频" options={options} onPick={onPick} />);
    const select = screen.getByLabelText('选择视频') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'a1' } });
    // 关键断言：DOM 值被重置回占位项，而不是停在刚才选中的素材上。
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'a1' } });
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it('占位项不可选，选中它不会触发动作', () => {
    const onPick = vi.fn();
    render(<ActionSelect label="选择视频" placeholder="选择视频" options={options} onPick={onPick} />);
    const select = screen.getByLabelText('选择视频') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('disabled 时不响应选择', () => {
    const onPick = vi.fn();
    render(<ActionSelect label="选择视频" placeholder="选择视频" options={options} disabled onPick={onPick} />);
    const select = screen.getByLabelText('选择视频') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});
