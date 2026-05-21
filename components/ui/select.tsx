'use client'

import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

const selectVariants = cva(
  "border-transparent data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-[0px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex items-center justify-between gap-1 rounded-lg border bg-transparent px-2 py-1 text-sm whitespace-nowrap transition-[color,box-shadow] outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-input',
        ghost: 'hover:bg-input dark:hover:bg-input/70 border-transparent shadow-none backdrop-blur',
        overlay: 'bg-white/90 text-neutral-800 hover:bg-white dark:bg-neutral-800/90 dark:text-white dark:hover:bg-neutral-800 disabled:opacity-80',
      },
      size: {
        default: 'h-9',
        sm: 'h-8 text-xs',
        xs: 'h-6 text-xs px-1 py-1',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'sm',
    },
  }
)

function SelectTrigger({
  className,
  size,
  variant,
  children,
  onClear,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> &
  VariantProps<typeof selectVariants> & {
    onClear?: () => void;
  }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(selectVariants({ variant, size, className }))}
      {...props}
    >
      {children}

      {/* "x" button to clear the value, uses <span> to prevent html button nesting */}
      {onClear ? (
        <span
          role="button"
          className="ml-auto -mr-1 inline-flex size-5 items-center justify-center rounded-md hover:bg-accent cursor-pointer"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClear();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onClear();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Icon name="x" className="size-2.5" />
        </span>
      ) : (
        <SelectPrimitive.Icon asChild>
          <Icon name="chevronDown" className="size-2.5 opacity-50" />
        </SelectPrimitive.Icon>
      )}
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'popper',
  align = 'center',
  searchable,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchLoading,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  searchable?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchLoading?: boolean;
}) {
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const isSearchFocusedRef = React.useRef(false);
  // Timestamp of the last keyboard-navigation key on the search input.
  // Used to distinguish a user-initiated focus transfer to an item (arrow
  // keys) from a programmatic one (e.g. Radix re-focusing after items
  // re-render when search results stream in).
  const lastNavKeyAtRef = React.useRef(0);

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-transparent shadow-md',
          searchable && '[&_[data-slot=select-item]:hover]:bg-accent [&_[data-slot=select-item]:hover]:text-accent-foreground',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className
        )}
        position={position}
        align={align}
        {...props}
      >
        {searchable && (
          <div
            className="sticky top-0 z-10 bg-popover p-1"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <div className="relative">
              <Input
                ref={searchInputRef}
                size="xs"
                placeholder={searchPlaceholder || 'Search...'}
                value={searchValue}
                onChange={(e) => onSearchChange?.(e.target.value)}
                disableKeyboardStep
                onKeyDown={(e) => {
                  // Let arrow keys / Enter / Escape bubble up so Radix can
                  // move the highlighted item and confirm selection; stop
                  // everything else from hijacking the Select's typeahead.
                  if (
                    e.key === 'ArrowUp' ||
                    e.key === 'ArrowDown' ||
                    e.key === 'Home' ||
                    e.key === 'End' ||
                    e.key === 'PageUp' ||
                    e.key === 'PageDown'
                  ) {
                    lastNavKeyAtRef.current = Date.now();
                  } else if (e.key !== 'Enter' && e.key !== 'Escape') {
                    e.stopPropagation();
                  }
                }}
                onFocus={() => { isSearchFocusedRef.current = true; }}
                onBlur={(e) => {
                  // Only allow focus transfer to an item when the user just
                  // pressed a navigation key. Otherwise (e.g. Radix
                  // re-focusing after the items list updates as search
                  // results stream in) refocus the search input so typing
                  // is uninterrupted.
                  const next = e.relatedTarget as HTMLElement | null;
                  const isUserNav = Date.now() - lastNavKeyAtRef.current < 150;
                  if (isUserNav && next?.closest('[role="option"]')) return;
                  requestAnimationFrame(() => {
                    if (isSearchFocusedRef.current) {
                      searchInputRef.current?.focus();
                    }
                  });
                }}
                className={cn(searchLoading && 'pr-7')}
              />
              {searchLoading && (
                <Spinner className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5" />
              )}
            </div>
          </div>
        )}
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1'
          )}
          onPointerDown={searchable ? () => { isSearchFocusedRef.current = false; } : undefined}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('text-muted-foreground px-2 py-1.5 text-[10px]', className)}
      {...props}
    />
  )
}

// Memoized so the dozens of right-sidebar `<Select>`s (which keep their items
// mounted in a hidden DocumentFragment even when closed, for Radix keyboard
// typeahead) don't re-render every item on every layer-selection cascade.
// Most call sites pass primitive `value` + string `children`, so the shallow
// prop compare bails cheaply.
const SelectItem = React.memo(function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-xs outline-hidden select-none overflow-hidden data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Icon name="check" className="size-3 opacity-50" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {/*
        Render ItemText as a flex span so icon + label sit on the same line.
        Without this, Tailwind preflight forces the icon to display:block and it
        wraps onto its own line inside Radix's default inline ItemText wrapper.
      */}
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap">
        <SelectPrimitive.ItemText asChild>
          <span className="flex items-center gap-2">{children}</span>
        </SelectPrimitive.ItemText>
      </span>
    </SelectPrimitive.Item>
  )
});

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        'flex cursor-default items-center justify-center py-1',
        className
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        'flex cursor-default items-center justify-center py-1',
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectVariants,
}
