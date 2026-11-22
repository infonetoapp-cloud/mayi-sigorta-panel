import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

export function CustomerEditDialog({
  title,
  open = true,
  onDismiss,
  children,
}: {
  title: string;
  open?: boolean;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const nativeDialog = typeof HTMLDialogElement.prototype.showModal === 'function';

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open) return;
    dialog?.showModal?.();
    return () => dialog?.close?.();
  }, [open]);

  return (
    <dialog
      ref={ref}
      open={nativeDialog ? undefined : open}
      className="customer-edit-dialog"
      aria-labelledby={titleId}
      closedby={onDismiss ? 'closerequest' : 'none'}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss?.();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
      </header>
      <div className="customer-edit-dialog-content">{children}</div>
    </dialog>
  );
}
