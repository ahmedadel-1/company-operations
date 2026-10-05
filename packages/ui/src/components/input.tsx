import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

const fieldClasses =
  'w-full min-h-11 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldClasses, className)} {...props} />;
}

/** Native select: fully keyboard and screen-reader accessible, and a native picker on mobile. */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(fieldClasses, 'pe-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClasses, 'py-2 leading-relaxed', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium', className)} {...props} />;
}
