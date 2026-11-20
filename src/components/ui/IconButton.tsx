import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Placement } from '@floating-ui/react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import styles from './IconButton.module.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name (aria-label) — also the tooltip text unless `tooltip` overrides it. */
  label: string;
  icon: LucideIcon;
  /** Square size in px (default 28). */
  size?: 24 | 28;
  /** Icon size override (default 16 for 28px, 16 for 24px). */
  iconSize?: number;
  /** Tooltip: true (default) shows `label`; a node shows custom content; false disables. */
  tooltip?: boolean | ReactNode;
  /** Shortcut hint under the tooltip text, e.g. "[" or "⌘Z". */
  hint?: ReactNode;
  tooltipPlacement?: Placement;
  active?: boolean;
  /** Small red dot on the top-right corner (e.g. overdue indicator). */
  dot?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    size = 28,
    iconSize,
    tooltip = true,
    hint,
    tooltipPlacement,
    active,
    dot,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx(styles.button, size === 24 ? styles.s24 : styles.s28, active && styles.active, className)}
      data-dot={dot ? 'true' : undefined}
      {...rest}
    >
      <Icon icon={icon} size={iconSize ?? 16} className={styles.icon} />
      {dot && <span className={styles.dot} aria-hidden="true" />}
    </button>
  );
  if (tooltip === false) return button;
  return (
    <Tooltip content={tooltip === true ? label : tooltip} hint={hint} placement={tooltipPlacement}>
      {button}
    </Tooltip>
  );
});
