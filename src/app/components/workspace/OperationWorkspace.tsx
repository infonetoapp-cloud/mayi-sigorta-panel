import { useRef, type ReactNode, type KeyboardEvent } from 'react';
export interface WorkspaceOperation {
  id: string;
  label: string;
  risk?: boolean;
  unresolved?: boolean;
}
/** Presentation only. The owning domain controller keeps its frozen request and draft. */
export function OperationSelector({
  items,
  active,
  onChange,
}: {
  items: readonly WorkspaceOperation[];
  active: string;
  onChange: (id: string) => void;
}) {
  const controls = useRef(new Map<string, HTMLButtonElement>());
  function activate(id: string) {
    onChange(id);
    controls.current.get(id)?.focus();
  }
  function key(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % items.length
        : event.key === 'ArrowLeft'
          ? (index + items.length - 1) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      const item = items[next];
      if (item) controls.current.get(item.id)?.focus();
    }
  }
  return (
    <nav className="crm-operation-selector" aria-label="Çalışma işlemleri">
      <div role="toolbar" aria-label="İşlem seçimi">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={active === item.id}
            tabIndex={active === item.id ? 0 : -1}
            aria-controls={`operation-${item.id}`}
            ref={(node) => {
              if (node) controls.current.set(item.id, node);
              else controls.current.delete(item.id);
            }}
            onKeyDown={(event) => key(event, index)}
            onClick={() => activate(item.id)}
          >
            <span>{item.label}</span>
            {item.risk && (
              <span
                className="crm-risk-dot"
                aria-label={item.unresolved ? 'Sonuç doğrulanmalı' : 'Taslak korunuyor'}
              >
                ●
              </span>
            )}
          </button>
        ))}
      </div>
      {items.some((item) => item.risk && item.id !== active) && (
        <div className="crm-retained-work" role="status">
          <span>İşlem korunuyor</span>
          {items
            .filter((item) => item.risk && item.id !== active)
            .map((item) => (
              <button type="button" key={item.id} onClick={() => activate(item.id)}>
                {item.label} — {item.unresolved ? 'sonucu doğrula' : 'taslağa dön'}
              </button>
            ))}
        </div>
      )}
    </nav>
  );
}
export function OperationPanel({
  id,
  title,
  active,
  children,
}: {
  id: string;
  title: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="workspace-section crm-operation-panel"
      id={`operation-${id}`}
      data-title={title}
      data-open={active}
      aria-label={title}
      hidden={!active}
    >
      <div className="workspace-section-body">{children}</div>
    </section>
  );
}
