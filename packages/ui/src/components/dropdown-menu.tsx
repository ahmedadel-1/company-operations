import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

/**
 * Non-modal by default: a modal menu sets `aria-hidden` on the rest of the page while it still has
 * focusable content (axe `aria-hidden-focus`). Focus still moves into the menu and Escape closes it.
 */
export function DropdownMenu({ modal = false, ...props }: ComponentProps<typeof MenuPrimitive.Root>) {
  return <MenuPrimitive.Root modal={modal} {...props} />;
}
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 max-h-[70dvh] min-w-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

const itemClasses =
  'relative flex min-h-11 cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:size-4';

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof MenuPrimitive.Item>) {
  return <MenuPrimitive.Item className={cn(itemClasses, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClasses, 'ps-8', className)} {...props}>
      <span className="absolute start-2 inline-flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <span aria-hidden="true" className="block size-2 rounded-full bg-current" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-2 py-1.5 text-xs text-muted-foreground', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
