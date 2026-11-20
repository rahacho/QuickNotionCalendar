import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useMergeRefs,
  useRole,
  type Placement,
} from '@floating-ui/react';
import { AnimatePresence, motion } from 'motion/react';
import { DUR, EASE } from '@/lib/motion';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: ReactNode;
  /** Secondary line/inline hint, e.g. a keyboard shortcut "⌘Z". */
  hint?: ReactNode;
  placement?: Placement;
  /** Hover delay in ms before showing (default 400). */
  delay?: number;
  disabled?: boolean;
  /** A single element that can hold a ref (DOM element or forwardRef component). */
  children: ReactElement;
}

type RefCarrier = { ref?: Ref<Element> } & Record<string, unknown>;

/**
 * Notion tooltip: dark rounded label after a short hover delay (mouse) or on keyboard focus.
 * Never shows on touch.
 */
export function Tooltip({ content, hint, placement = 'bottom', delay = 400, disabled, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const enabled = !disabled && content != null && content !== false && content !== '';
  const { refs, floatingStyles, context, placement: finalPlacement } = useFloating({
    open: enabled && open,
    onOpenChange: setOpen,
    placement,
    strategy: 'fixed',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { enabled, delay: { open: delay, close: 0 }, mouseOnly: true, move: false });
  const focus = useFocus(context, { enabled, visibleOnly: true });
  const dismiss = useDismiss(context, { enabled, referencePress: true });
  const role = useRole(context, { role: 'tooltip', enabled });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

  const childProps = (isValidElement(children) ? children.props : {}) as RefCarrier;
  const mergedRef = useMergeRefs([refs.setReference, childProps.ref]);

  if (!isValidElement(children)) return <>{children}</>;

  const side = finalPlacement.split('-')[0];
  const dy = side === 'top' ? 2 : side === 'bottom' ? -2 : 0;
  const dx = side === 'left' ? 2 : side === 'right' ? -2 : 0;

  return (
    <>
      {cloneElement(children as ReactElement<RefCarrier>, {
        ...getReferenceProps(childProps),
        ref: mergedRef,
      })}
      <FloatingPortal>
        <AnimatePresence>
          {enabled && open && (
            <div ref={refs.setFloating} style={{ ...floatingStyles, zIndex: 'var(--z-popover)' }} {...getFloatingProps()}>
              <motion.div
                className={styles.tooltip}
                initial={{ opacity: 0, x: dx, y: dy }}
                animate={{ opacity: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, transition: { duration: DUR.instant } }}
                transition={{ duration: DUR.fast, ease: EASE }}
              >
                <span className={styles.content}>{content}</span>
                {hint != null && hint !== '' && <span className={styles.hint}>{hint}</span>}
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </FloatingPortal>
    </>
  );
}
