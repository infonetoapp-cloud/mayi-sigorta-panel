import { useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../ui/button';
/** Native modal owns focus/Escape; lazy readers mount only while their dialog is open. */
export function RecordDetails({
  title,
  triggerLabel,
  lazy = false,
  children,
}: {
  title: string;
  triggerLabel?: string;
  lazy?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        aria-label={triggerLabel ? title : undefined}
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        {triggerLabel ?? title}
      </Button>
      <dialog
        ref={dialog}
        className="crm-record-dialog"
        aria-labelledby={id}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        <header>
          <h2 id={id}>{title}</h2>
          <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
            Ayrıntıları kapat
          </Button>
        </header>
        <div className="crm-record-content">{!lazy || open ? children : null}</div>
      </dialog>
    </>
  );
}
