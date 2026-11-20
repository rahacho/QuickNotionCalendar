import { useId, type ReactNode } from 'react';
import type { Placement } from '@floating-ui/react';
import { Popover, type PopoverAnchor } from '@/components/ui/Popover';
import { Sheet } from '@/components/ui/Sheet';
import styles from './EditorSurface.module.css';

export interface EditorSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Popover anchor (desktop / tablet). */
  anchor: PopoverAnchor;
  /** Phone: a titled bottom sheet instead of a popover. */
  phone: boolean;
  title: string;
  placement?: Placement;
  width?: number;
  'data-testid'?: string;
  children: ReactNode;
}

/**
 * Where a property editor opens: a Notion popover next to its value on desktop/tablet, a bottom
 * sheet with a title + Done on phones (like Notion mobile). Content must close itself via its own
 * onDone (there is no popover context inside the sheet).
 */
export function EditorSurface({ open, onOpenChange, anchor, phone, title, placement = 'bottom-start', width, children, ...rest }: EditorSurfaceProps) {
  const titleId = useId();
  const close = () => onOpenChange(false);
  if (phone) {
    return (
      <Sheet open={open} onClose={close} labelledBy={titleId} data-testid={rest['data-testid']}>
        <div className={styles.header}>
          <span id={titleId} className={styles.title}>
            {title}
          </span>
          <button type="button" className={styles.done} onClick={close}>
            Done
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </Sheet>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      placement={placement}
      width={width}
      role="none"
      aria-label={title}
      data-testid={rest['data-testid']}
    >
      {children}
    </Popover>
  );
}
