import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** Hide presentation only: mounted children retain draft, request and proof state. */
export function WorkspaceSection({
  title,
  description,
  initialOpen = false,
  pinned = false,
  children,
}: {
  title: string;
  description: string;
  initialOpen?: boolean;
  pinned?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(initialOpen);
  const open = expanded || pinned;
  useEffect(() => {
    if (pinned) setExpanded(true);
  }, [pinned]);
  return (
    <section className="workspace-section" data-open={open}>
      <h3 className="workspace-section-heading">
        <button
          type="button"
          className="workspace-section-toggle"
          aria-label={title}
          aria-controls={id}
          aria-expanded={open}
          aria-disabled={pinned || undefined}
          onClick={() => {
            if (!pinned) setExpanded((value) => !value);
          }}
        >
          <span>
            <span className="workspace-section-title">{title}</span>
            <span className="workspace-section-description">{description}</span>
          </span>
          <span className="workspace-section-indicator">
            {pinned && <span className="workspace-pinned">İşlem açık</span>}
            <ChevronDown size={18} aria-hidden="true" />
          </span>
        </button>
      </h3>
      {pinned && (
        <p className="workspace-pinned-help">
          Taslağı kapatmadan veya işlemi doğrulamadan bu bölüm gizlenmez.
        </p>
      )}
      <div id={id} className="workspace-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
