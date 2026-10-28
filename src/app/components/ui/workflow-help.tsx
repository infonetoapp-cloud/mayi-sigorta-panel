import type { ReactNode } from 'react';
/** Optional context stays available without competing with the employee's active form. */
export function WorkflowHelp({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="workflow-help">
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}
