import * as React from 'react'

import { cn } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'

interface InputProps extends Omit<React.ComponentProps<'input'>, 'size'> {
  size?: 'xs' | 'sm';
  variant?: 'default' | 'rename' | 'rename-selected';
  stepper?: boolean;
  onStepperChange?: (value: string) => void;
  /**
   * Disable the implicit ArrowUp/ArrowDown numeric-stepping behavior.
   * Use for text-only inputs (e.g. search fields) where pressing arrow keys
   * should be left to the parent for navigation/highlighting instead of
   * incrementing the value.
   */
  disableKeyboardStep?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({
  className,
  type,
  size = 'xs',
  variant = 'default',
  onKeyDown,
  value,
  onChange,
  stepper = false,
  onStepperChange,
  disableKeyboardStep = false,
  min,
  max,
  step = '1',
  ...props
}, forwardedRef) {
  const internalRef = React.useRef<HTMLInputElement>(null);
  const inputRef = (forwardedRef || internalRef) as React.RefObject<HTMLInputElement>;
  const sizeClasses = {
    xs: 'h-8 text-xs px-2 py-1 rounded-lg',
    sm: 'h-10 text-sm px-3 py-1.5 rounded-xl',
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Only handle arrow keys for numeric inputs
    if (!disableKeyboardStep && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const currentValue = typeof value === 'string' ? value : String(value || '');

      // Check if the value is a valid number or empty (treat empty as 0)
      const numValue = currentValue === '' ? 0 : parseFloat(currentValue);
      if (!isNaN(numValue) && isFinite(numValue)) {
        e.preventDefault();

        const increment = e.shiftKey ? 10 : 1;
        let newValue = e.key === 'ArrowUp'
          ? numValue + increment
          : numValue - increment;

        // Respect min/max constraints
        if (min !== undefined) {
          const minValue = Number(min);
          if (!isNaN(minValue)) {
            newValue = Math.max(newValue, minValue);
          }
        }
        if (max !== undefined) {
          const maxValue = Number(max);
          if (!isNaN(maxValue)) {
            newValue = Math.min(newValue, maxValue);
          }
        }

        // Create a synthetic event to trigger onChange
        if (inputRef.current && onChange) {
          const inputElement = inputRef.current;
          // Set the value on the input element
          inputElement.value = String(newValue);

          // Create event with the input element as both target and currentTarget
          const syntheticEvent = {
            target: inputElement,
            currentTarget: inputElement,
          } as unknown as React.ChangeEvent<HTMLInputElement>;

          onChange(syntheticEvent);
        }
        return;
      }
    }

    // Call original onKeyDown if provided
    onKeyDown?.(e);
  };

  const handleIncrement = () => {
    const currentValue = Number(value) || 0;
    const stepValue = Number(step);
    const maxValue = max ? Number(max) : Infinity;
    const newValue = Math.min(currentValue + stepValue, maxValue);

    if (onStepperChange) {
      onStepperChange(String(newValue));
    } else if (onChange && inputRef.current) {
      const inputElement = inputRef.current;
      inputElement.value = String(newValue);
      const syntheticEvent = {
        target: inputElement,
        currentTarget: inputElement,
      } as unknown as React.ChangeEvent<HTMLInputElement>;
      onChange(syntheticEvent);
    }
  };

  const handleDecrement = () => {
    const currentValue = Number(value) || 0;
    const stepValue = Number(step);
    const minValue = min ? Number(min) : -Infinity;
    const newValue = Math.max(currentValue - stepValue, minValue);

    if (onStepperChange) {
      onStepperChange(String(newValue));
    } else if (onChange && inputRef.current) {
      const inputElement = inputRef.current;
      inputElement.value = String(newValue);
      const syntheticEvent = {
        target: inputElement,
        currentTarget: inputElement,
      } as unknown as React.ChangeEvent<HTMLInputElement>;
      onChange(syntheticEvent);
    }
  };

  if (stepper) {
    return (
      <div className="group relative w-full">
        <input
          ref={inputRef}
          type={type}
          data-slot="input"
          min={min}
          max={max}
          step={step}
          className={cn(
            'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground bg-input border-transparent w-full min-w-0 border transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium disabled:cursor-not-allowed disabled:opacity-50',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[0px]',
            '',
            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
            sizeClasses[size],
            stepper && !props.disabled && 'pr-8',
            className
          )}
          value={value}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          {...props}
        />
        {!props.disabled && (
          <div className="absolute right-px top-px bottom-px items-center rounded-r-[10px] hidden group-hover:flex px-1.5">
            <div className="flex flex-col -gap-px">
              <span
                role="button"
                tabIndex={-1}
                className="p-0 opacity-50 hover:opacity-100 transition-opacity cursor-pointer"
                onClick={handleIncrement}
              >
                <Icon name="chevronUp" className="size-2.5" />
              </span>
              <span
                role="button"
                tabIndex={-1}
                className="p-0 opacity-50 hover:opacity-100 transition-opacity cursor-pointer -mt-0.5"
                onClick={handleDecrement}
              >
                <Icon name="chevronDown" className="size-2.5" />
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  const variantClasses = {
    default: cn(
      'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground bg-input border-transparent w-full min-w-0 border transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium disabled:cursor-not-allowed disabled:opacity-50',
      'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[0px]',
      'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
      '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
      sizeClasses[size],
    ),
    rename: 'bg-black/5 dark:bg-white/10 rounded px-1 py-0.5 outline-none min-w-0 text-xs font-medium text-foreground placeholder:text-muted-foreground',
    'rename-selected': 'bg-white/20 rounded px-1 py-0.5 outline-none min-w-0 text-xs font-medium text-white placeholder:text-white/40',
  };

  return (
    <input
      ref={inputRef}
      type={type}
      data-slot="input"
      className={cn(variantClasses[variant], className)}
      value={value}
      onChange={onChange}
      onKeyDown={handleKeyDown}
      {...props}
    />
  )
});

export { Input }
