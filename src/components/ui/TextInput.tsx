import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import styles from './TextInput.module.css';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Leading icon inside the field. */
  icon?: LucideIcon;
  /** Trailing content inside the field (e.g. a Kbd hint or clear button). */
  trailing?: ReactNode;
  /** 'default' = Notion filled input (32px); 'plain' = borderless inline text (inherits size). */
  variant?: 'default' | 'plain';
  /** Applied to the <input>; `className` styles the outer field box. */
  inputClassName?: string;
  invalid?: boolean;
}

/** Notion text field. The forwarded ref points at the <input>. 16px font on touch devices (no iOS zoom). */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { icon, trailing, variant = 'default', className, inputClassName, invalid, type = 'text', ...rest },
  ref,
) {
  return (
    <div
      className={cx(
        styles.field,
        variant === 'plain' ? styles.plain : styles.filled,
        icon && styles.withIcon,
        trailing != null && styles.withTrailing,
        invalid && styles.invalid,
        rest.disabled && styles.disabled,
        className,
      )}
    >
      {icon && <Icon icon={icon} size={16} className={styles.icon} />}
      <input
        ref={ref}
        type={type}
        aria-invalid={invalid || undefined}
        className={cx(styles.input, inputClassName)}
        autoComplete={rest.autoComplete ?? 'off'}
        spellCheck={rest.spellCheck ?? true}
        {...rest}
      />
      {trailing != null && <div className={styles.trailing}>{trailing}</div>}
    </div>
  );
});
