import {
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useMergeRefs } from '@floating-ui/react';
import type { LucideIcon } from 'lucide-react';
import { Check, ChevronRight } from 'lucide-react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import { Popover, usePopoverClose } from './Popover';
import styles from './Menu.module.css';

interface MenuCtx {
  /** id of the item whose submenu is open (one at a time per menu). */
  openSub: string | null;
  /** `viaKeyboard` → the submenu focuses itself so ↑↓ keep working. */
  setOpenSub: (id: string | null, viaKeyboard?: boolean) => void;
  subViaKeyboard: boolean;
}

const MenuContext = createContext<MenuCtx | null>(null);

const ITEM_SELECTOR = '[data-menu-item]:not([aria-disabled="true"])';

function items(menu: HTMLElement): HTMLElement[] {
  // Only this menu's own items (submenus are portaled elsewhere, nested menus are excluded).
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (el) => el.closest('[role="menu"]') === menu,
  );
}

export interface MenuProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Focus the menu on mount so ↑↓ work immediately (default true). */
  autoFocus?: boolean;
}

/**
 * Notion menu list (put it inside a <Popover>). ↑/↓/Home/End move the highlight, Enter/Space select,
 * → opens a submenu, ← closes it. Hover and keyboard share one highlight (the focused item).
 */
export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu(
  { children, className, autoFocus = true, onKeyDown, onMouseLeave, ...rest },
  ref,
) {
  const localRef = useRef<HTMLDivElement>(null);
  const merged = useMergeRefs([localRef, ref]);
  const [sub, setSub] = useState<{ id: string | null; viaKeyboard: boolean }>({ id: null, viaKeyboard: false });
  const parentMenu = useContext(MenuContext);
  const popover = usePopoverClose();
  const openSub = sub.id;
  const ctx = useMemo<MenuCtx>(
    () => ({
      openSub: sub.id,
      subViaKeyboard: sub.viaKeyboard,
      setOpenSub: (id, viaKeyboard = false) => setSub({ id, viaKeyboard }),
    }),
    [sub],
  );

  useLayoutEffect(() => {
    const el = localRef.current;
    if (autoFocus && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [autoFocus]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const menu = localRef.current;
    if (!menu) return;
    const list = items(menu);
    if (!list.length) return;
    const idx = list.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = list[idx < 0 ? 0 : (idx + 1) % list.length];
        break;
      case 'ArrowUp':
        next = list[idx < 0 ? list.length - 1 : (idx - 1 + list.length) % list.length];
        break;
      case 'Home':
        next = list[0];
        break;
      case 'End':
        next = list[list.length - 1];
        break;
      case 'ArrowLeft':
        // Inside a submenu: close it and return to the parent item.
        if (parentMenu && popover) {
          e.preventDefault();
          e.stopPropagation();
          popover.close();
        }
        return;
      case 'Tab':
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    next?.focus({ preventScroll: false });
  };

  return (
    <MenuContext.Provider value={ctx}>
      <div
        ref={merged}
        role="menu"
        tabIndex={-1}
        className={cx(styles.menu, className)}
        onKeyDown={handleKeyDown}
        onMouseLeave={(e) => {
          onMouseLeave?.(e);
          // Drop the hover highlight when the pointer leaves (unless a submenu is open).
          const menu = localRef.current;
          if (menu && !openSub && menu.contains(document.activeElement) && document.activeElement !== menu) {
            menu.focus({ preventScroll: true });
          }
        }}
        {...rest}
      >
        {children}
      </div>
    </MenuContext.Provider>
  );
});

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  icon?: LucideIcon;
  label: ReactNode;
  /** Right-aligned secondary text (shortcut, current value). */
  hint?: ReactNode;
  danger?: boolean;
  /** Called on click / Enter. The whole menu chain closes afterwards unless `keepOpen`. */
  onSelect?: () => void;
  /** Nested menu content (MenuItems, or a <Menu>) shown to the right. */
  submenu?: ReactNode;
  /** Shows a ✓ on the right (single-choice menus like Month / Week). */
  selected?: boolean;
  keepOpen?: boolean;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { icon, label, hint, danger, onSelect, submenu, selected, keepOpen, disabled, className, onClick, onKeyDown, onMouseEnter, onMouseMove, onMouseLeave, ...rest },
  ref,
) {
  const menu = useContext(MenuContext);
  const popover = usePopoverClose();
  const id = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const merged = useMergeRefs([btnRef, ref]);
  const hasSub = submenu != null && submenu !== false;
  const subOpen = hasSub && menu?.openSub === id;
  const hoverTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const setSubOpen = useCallback(
    (open: boolean, viaKeyboard = false) => {
      if (!menu) return;
      if (open) menu.setOpenSub(id, viaKeyboard);
      else if (menu.openSub === id) menu.setOpenSub(null);
    },
    [menu, id],
  );

  const select = (viaKeyboard: boolean) => {
    if (disabled) return;
    if (hasSub) {
      setSubOpen(true, viaKeyboard);
      return;
    }
    onSelect?.();
    if (!keepOpen) popover?.closeAll();
  };

  const role = selected !== undefined ? 'menuitemradio' : 'menuitem';

  return (
    <>
      <button
        ref={merged}
        type="button"
        role={role}
        aria-checked={selected !== undefined ? selected : undefined}
        aria-disabled={disabled || undefined}
        aria-haspopup={hasSub ? 'menu' : undefined}
        aria-expanded={hasSub ? subOpen : undefined}
        tabIndex={-1}
        data-menu-item=""
        className={cx(styles.item, danger && styles.danger, subOpen && styles.subOpen, disabled && styles.disabled, className)}
        onClick={(e) => {
          // React events bubble through portals: ignore clicks that happened inside this item's submenu.
          if (!e.currentTarget.contains(e.target as Node)) return;
          onClick?.(e);
          // detail === 0 → activated from the keyboard (Enter/Space), not a pointer.
          if (!e.defaultPrevented) select(e.detail === 0);
        }}
        onKeyDown={(e) => {
          if (!e.currentTarget.contains(e.target as Node)) return;
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (hasSub && e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            setSubOpen(true, true);
          }
        }}
        onMouseEnter={(e) => {
          onMouseEnter?.(e);
          window.clearTimeout(hoverTimer.current);
          if (hasSub) {
            hoverTimer.current = window.setTimeout(() => setSubOpen(true), 90);
          } else if (menu?.openSub) {
            // Moving onto a sibling closes the open submenu after a short grace period.
            hoverTimer.current = window.setTimeout(() => menu.setOpenSub(null), 120);
          }
        }}
        onMouseMove={(e) => {
          onMouseMove?.(e);
          const el = btnRef.current;
          if (el && document.activeElement !== el && !disabled) el.focus({ preventScroll: true });
        }}
        onMouseLeave={(e) => {
          onMouseLeave?.(e);
          window.clearTimeout(hoverTimer.current);
        }}
        {...rest}
      >
        {icon && <Icon icon={icon} size={16} className={styles.icon} />}
        <span className={styles.label}>{label}</span>
        {hint != null && hint !== '' && <span className={styles.hint}>{hint}</span>}
        {selected && <Icon icon={Check} size={16} className={styles.trail} />}
        {hasSub && <Icon icon={ChevronRight} size={14} className={styles.trail} />}
      </button>
      {hasSub && (
        <Popover
          open={subOpen}
          onOpenChange={(o) => setSubOpen(o)}
          anchor={btnRef}
          placement="right-start"
          offset={2}
          role="none"
          initialFocus={-1}
          closeOnFocusOut={false}
        >
          {isValidElement(submenu) && submenu.type === Menu ? (
            submenu
          ) : (
            <Menu autoFocus={menu?.subViaKeyboard ?? true}>{submenu}</Menu>
          )}
        </Popover>
      )}
    </>
  );
});

export function MenuSeparator() {
  return <div role="separator" className={styles.separator} />;
}

/** Small section heading inside a menu. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className={styles.sectionLabel}>{children}</div>;
}
