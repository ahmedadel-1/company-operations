import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-muted text-foreground',
      success: 'border-success/40 text-success',
      warning: 'border-warning/40 text-warning',
      danger: 'border-destructive/40 text-destructive',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

/** Status chip. Always carries text: status is never conveyed by color alone (UI_UX.md §7). */
export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
