import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

function DropdownMenu(props) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}
function DropdownMenuTrigger(props) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}
function DropdownMenuContent({ className, sideOffset = 4, ...props }) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn('z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md', className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}
function DropdownMenuLabel({ className, ...props }) {
  return <DropdownMenuPrimitive.Label data-slot="dropdown-menu-label" className={cn('px-2 py-1.5 text-sm font-medium', className)} {...props} />;
}
function DropdownMenuSeparator({ className, ...props }) {
  return <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
function DropdownMenuRadioGroup(props) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}
function DropdownMenuRadioItem({ className, children, ...props }) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>●</DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem };
