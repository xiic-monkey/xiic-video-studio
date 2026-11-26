import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface InspectorSectionProps {
  title: string;
  /** 默认展开。字段与模型是主要工作区，默认展开；其余按需展开。 */
  defaultOpen?: boolean;
  /** 右侧附加内容（状态徽章、链接按钮等）。 */
  aside?: ReactNode;
  children: ReactNode;
}

/**
 * Inspector 的可折叠段落。
 *
 * 以前 8 个段落全部铺开，找「检查」要滚很久。
 * 现在按标题折叠：字段与模型默认展开，其余段落收起但标题可见。
 */
export function InspectorSection({ title, defaultOpen = false, aside, children }: InspectorSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`inspector-section ${open ? 'is-open' : 'is-collapsed'}`}>
      <div className="inspector-section-head">
        <button
          type="button"
          className="inspector-section-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <h3>{title}</h3>
        </button>
        {aside}
      </div>
      {open && <div className="inspector-section-body">{children}</div>}
    </section>
  );
}
