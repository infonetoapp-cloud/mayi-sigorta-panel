import type { ReactNode } from 'react';
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1 tabIndex={-1} data-page-title>
          {title}
        </h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function PageContainer({ children }: { children: ReactNode }) {
  return <div className="page-container">{children}</div>;
}
