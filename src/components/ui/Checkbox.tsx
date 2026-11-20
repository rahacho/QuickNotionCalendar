import { forwardRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'children'> {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Box size in px (default 16). */
  size?: number;
  /** Optional clickable label rendered after the box. */
  label?: ReactNode;
  /** 'large': a 44px invisible hit area on touch screens (a lone checkbox, e.g. the peek's Done). */
  hitArea?: 'default' | 'large';
}

/**
 * Notion to-do checkbox. Checking fills it with the accent blue, pops to 1.12 and draws the white check.
 * role="checkbox" + aria-checked; Space/Enter toggle. Click propagation is stopped so a checkbox inside a
 * clickable row doesn't also open the row.
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { checked, onChange, size = 16, label, hitArea = 'default', className, style, disabled, onClick, ...rest },
  ref,
) {
  // Derived-state pattern: bump the pop key synchronously when the box becomes checked, so the
  // pop + draw animation starts on the very frame the check appears (no flash of a static check).
  const [prevChecked, setPrevChecked] = useState(checked);
  const [popKey, setPopKey] = useState(0);
  if (checked !== prevChecked) {
    setPrevChecked(checked);
    if (checked) setPopKey((k) => k + 1);
  }

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
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className={cx(styles.root, checked && styles.checked, label != null && styles.withLabel, hitArea === 'large' && styles.large, className)}
      style={{ ...style, '--cb-size': `${size}px` } as CSSProperties}
      onClick={handleClick}
      {...rest}
    >
      <span key={popKey} className={cx(styles.box, checked && popKey > 0 && styles.popping)} aria-hidden="true">
        <svg className={styles.check} viewBox="0 0 16 16" fill="none">
          <path d="M3.75 8.25 6.5 11l5.75-5.75" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {label != null && <span className={styles.label}>{label}</span>}
    </button>
  );
});
