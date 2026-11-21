import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
// shadcn/ui source-owned Input primitive (MIT).
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex min-h-[var(--control-size)] w-full min-w-0 rounded-md border border-control-border bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}
