import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

/** Wide tables scroll inside their container, never the page (UI_UX.md §6). */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn('h-10 px-3 text-start align-middle font-medium whitespace-nowrap text-muted-foreground', className)}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('border-b last:border-0', className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2 align-middle', className)} {...props} />;
}
