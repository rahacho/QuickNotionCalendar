import { forwardRef, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { cx } from '@/lib/cx';
import styles from './Toggle.module.css';

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'children'> {
  checked: boolean;
  onChange: (next: boolean) => void;
}

/** Notion switch: accent track when on, --toggle-off when off; knob glides 200ms. role="switch". */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, onChange, className, disabled, onClick, ...rest },
  ref,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClick?.(e);
    if (e.defaultPrevented || disabled) return;
    onChange(!checked);
  };
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx(styles.toggle, checked && styles.on, className)}
      onClick={handleClick}
      {...rest}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
});
