import { useEffect, useRef, type ReactNode } from 'react';

/** Native top-layer decision: does not unmount the underlying draft or alter its request. */
export function NavigationDecision({
  children,
  onStay,
}: {
  children: ReactNode;
  onStay: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal?.();
    return () => dialog?.close?.();
  }, []);
  return (
    <dialog
      ref={ref}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function' ? true : undefined}
      className="navigation-decision"
      aria-labelledby="navigation-decision-title"
      onCancel={(event) => {
        event.preventDefault();
        onStay();
      }}
    >
      {children}
    </dialog>
  );
}
