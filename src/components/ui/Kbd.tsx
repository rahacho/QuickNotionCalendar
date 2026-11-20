import type { HTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import { hotkeyLabel } from '@/lib/hotkeys';
import styles from './Kbd.module.css';

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** Combo like "mod+z" rendered platform-aware ("⌘Z" / "Ctrl+Z"). Alternative to children. */
  combo?: string;
}

/** Keyboard key cap, e.g. <Kbd>⌘Z</Kbd> or <Kbd combo="mod+z" />. */
export function Kbd({ combo, className, children, ...rest }: KbdProps) {
  return (
    <kbd className={cx(styles.kbd, className)} {...rest}>
      {combo ? hotkeyLabel(combo) : children}
    </kbd>
  );
}
