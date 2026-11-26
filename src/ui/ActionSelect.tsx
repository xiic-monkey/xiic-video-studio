import { useState } from 'react';

interface ActionSelectProps {
  /** 无障碍标签，同时作为下拉的无标题说明。 */
  label: string;
  /** 触发动作时下拉的占位文案。 */
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onPick(value: string): void;
}

/**
 * 动作型下拉。
 *
 * 它不是表单字段，而是一个「选一项就触发一次动作」的按钮：
 * - 选完之后立刻回到占位项，用户可以重复选同一个素材；
 * - 普通 `<select value="">` 做不到这点：受控值恒为空时浏览器不会重置，
 *   第二次选同一个值不会触发 onChange。
 *
 * 做法是受控 value 记在 state 里，选中后立刻置回空串并强制重渲染，
 * 于是 DOM 的选中态被重置，同一项可以再次触发。
 */
export function ActionSelect({ label, placeholder, options, disabled, onPick }: ActionSelectProps) {
  const [selected, setSelected] = useState('');

  return (
    <select
      aria-label={label}
      value={selected}
      disabled={disabled}
      onChange={(event) => {
        const value = event.currentTarget.value;
        if (!value) return;
        // 先重置再回调：回调可能抛错或打开确认框，DOM 必须已经回到占位态。
        setSelected('');
        onPick(value);
      }}
    >
      <option value="" disabled>{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}
