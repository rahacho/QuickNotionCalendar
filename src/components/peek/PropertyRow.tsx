import { forwardRef, type HTMLAttributes, type ReactElement, type ReactNode, type Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/cx';
import { Icon } from '@/components/ui/Icon';
import { Tooltip } from '@/components/ui/Tooltip';
import styles from './PropertyRow.module.css';

export interface PropertyRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'onClick'> {
  icon: LucideIcon;
  label: string;
  /** The value. Strings render as text; pass `empty` to show the placeholder style. */
  children: ReactNode;
  /**
   * 'button' (default): the value box is a hoverable button that opens an editor.
   * 'box': a hoverable box that isn't itself a button (e.g. holds a checkbox).
   * 'static': read-only text, no hover.
   */
  kind?: 'button' | 'box' | 'static';
  onClick?: () => void;
  /** The editor popover for this value is open (pressed look). */
  active?: boolean;
  /** Shown in --text-placeholder (e.g. "Empty", "Never"). */
  empty?: boolean;
  /** Not editable right now; `disabledReason` becomes a tooltip. */
  disabled?: boolean;
  disabledReason?: string;
  /** Value color: overdue dates read red. */
  tone?: 'default' | 'danger';
}

/**
 * One Notion property row: icon + 160px label, then a 4px-radius value box that highlights on hover.
 * The forwarded ref points at the value element (popover anchor).
 */
export const PropertyRow = forwardRef<HTMLElement, PropertyRowProps>(function PropertyRow(
  { icon, label, children, kind = 'button', onClick, active, empty, disabled, disabledReason, tone = 'default', className, ...rest },
  ref,
) {
  const valueClass = cx(
    styles.value,
    kind !== 'static' && styles.interactive,
    active && styles.active,
    empty && styles.empty,
    disabled && styles.disabled,
    tone === 'danger' && styles.danger,
  );

  let value: ReactNode;
  if (kind === 'button') {
    value = (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        className={valueClass}
        aria-disabled={disabled || undefined}
        aria-expanded={disabled ? undefined : active}
        onClick={() => {
          if (!disabled) onClick?.();
        }}
        {...rest}
      >
        {children}
      </button>
    );
  } else {
    value = (
      <div
        ref={ref as Ref<HTMLDivElement>}
        className={valueClass}
        onClick={() => {
          if (!disabled) onClick?.();
        }}
        {...rest}
      >
        {children}
      </div>
    );
  }

  return (
    <div className={cx(styles.row, className)}>
      <div className={styles.label}>
        <Icon icon={icon} size={16} className={styles.icon} />
        <span className={styles.labelText}>{label}</span>
      </div>
      {disabled && disabledReason ? (
        <Tooltip content={disabledReason} placement="bottom-start">
          {value as ReactElement}
        </Tooltip>
      ) : (
        value
      )}
    </div>
  );
});
