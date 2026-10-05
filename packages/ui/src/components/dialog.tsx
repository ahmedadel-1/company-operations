import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly closeLabel: string;
  /** `sheet` slides in from the inline-start edge (mobile navigation). */
  readonly variant?: 'dialog' | 'sheet';
}

/** Modal dialog; a full-screen sheet below 768 px (UI_UX.md §6). Focus is trapped and restored by Radix. */
export function DialogContent({
  className,
  children,
  title,
  description,
  closeLabel,
  variant = 'dialog',
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col gap-4 overflow-y-auto bg-background p-6 shadow-lg',
          variant === 'dialog'
            ? 'inset-0 md:inset-auto md:top-1/2 md:left-1/2 md:max-h-[85dvh] md:w-full md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:border'
            : 'inset-y-0 start-0 w-80 max-w-[85vw] border-e',
          className,
        )}
        {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        {...props}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
            {description === undefined ? null : (
              <DialogPrimitive.Description className="text-sm text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="-m-2 inline-flex size-11 items-center justify-center rounded-md hover:bg-accent"
            aria-label={closeLabel}
          >
            <XIcon aria-hidden="true" className="size-4" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
