import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-lg border bg-card text-card-foreground', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap items-center justify-between gap-3 p-4 pb-0', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-base font-semibold', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...props} />;
}
