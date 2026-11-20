import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import styles from './Button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'ghost' | 'primary' | 'secondary' | 'danger';
  /** sm = 28px (Notion toolbar), md = 32px. */
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  /** Trailing icon, e.g. the ⌄ of a "Month ⌄" switcher. */
  iconRight?: LucideIcon;
  /** Pressed/selected look (e.g. the button that opened a menu). */
  active?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'sm', icon, iconRight, active, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        active && styles.active,
        !children && styles.iconOnly,
        className,
      )}
      {...rest}
    >
      {icon && <Icon icon={icon} size={16} className={styles.icon} />}
      {children != null && children !== false && <span className={styles.label}>{children}</span>}
      {iconRight && <Icon icon={iconRight} size={14} className={cx(styles.icon, styles.iconRight)} />}
    </button>
  );
});
