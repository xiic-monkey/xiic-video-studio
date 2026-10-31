import type { FieldDef } from '../domain/nodes/types';
import { useBoardStore } from '../stores/boardStore';

export interface FieldChangeOptions {
  history: boolean;
}

interface FieldEditorProps {
  field: FieldDef;
  value: unknown;
  onChange(field: FieldDef, value: unknown, options: FieldChangeOptions): void;
}

export function FieldEditor({ field, value, onChange }: FieldEditorProps) {
  const textual = field.type === 'text' || field.type === 'textarea';

  function onTextChange(next: string) {
    onChange(field, next, { history: false });
  }

  return (
    <div className="inspector-field">
      <span>{field.label}</span>
      {field.type === 'textarea' && (
        <textarea
          className="nodrag"
          rows={4}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onFocus={() => useBoardStore.getState().beginGesture()}
          onBlur={() => useBoardStore.getState().endGesture()}
          onChange={(event) => onTextChange(event.target.value)}
        />
      )}
      {field.type === 'text' && (
        <input
          className="nodrag"
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onFocus={() => useBoardStore.getState().beginGesture()}
          onBlur={() => useBoardStore.getState().endGesture()}
          onChange={(event) => onTextChange(event.target.value)}
        />
      )}
      {field.type === 'number' && (
        <input
          className="nodrag"
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={field.placeholder}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(field, raw === '' ? '' : Number(raw), { history: true });
          }}
        />
      )}
      {field.type === 'select' && (
        <select
          className="nodrag"
          value={String(value ?? '')}
          onChange={(event) => onChange(field, event.target.value, { history: true })}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      )}
      {field.type === 'toggle' && (
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          className="inspector-toggle"
          onClick={() => onChange(field, !value, { history: true })}
        >
          <span>{Boolean(value) ? '开启' : '关闭'}</span>
          <i />
        </button>
      )}
      {field.help && <small>{field.help}</small>}
      {textual && <small>编辑时自动合并为一个撤销步骤</small>}
    </div>
  );
}
