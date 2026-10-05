import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

export const buttonVariants = cva(
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'min-h-0 px-0 text-foreground underline underline-offset-4 hover:no-underline',
      },
      size: {
        default: '',
        sm: 'min-h-9 px-3',
        icon: 'size-11 px-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Renders the child element (e.g. a link) with button styling. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  if (asChild) {
    return <Slot.Root className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  }
  return <button type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
