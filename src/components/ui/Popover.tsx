import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingNode,
  FloatingPortal,
  FloatingTree,
  offset as offsetMw,
  shift,
  size as sizeMw,
  useDismiss,
  useFloating,
  useFloatingNodeId,
  useFloatingParentNodeId,
  useInteractions,
  useRole,
  useTransitionStyles,
  type Placement,
  type VirtualElement,
} from '@floating-ui/react';
import { cx } from '@/lib/cx';
import { LayerDepthContext, useLayer } from '@/lib/layers';
import { DUR_MS } from '@/lib/motion';
import styles from './Popover.module.css';

export type PopoverAnchor = RefObject<Element | null> | Element | VirtualElement | null;

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The element (or ref to it, or a virtual point) the popover is positioned against. */
  anchor: PopoverAnchor;
  /** Default 'bottom-start'. Flips/shifts to stay on screen. */
  placement?: Placement;
  /** Gap from the anchor in px (default 4). */
  offset?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Fixed width of the panel (number = px). */
  width?: number | string;
  /** Make the panel at least as wide as the anchor. */
  matchAnchorWidth?: boolean;
  /** Which tabbable gets focus on open: index, a ref, or -1 for none (default 0 = first tabbable). */
  initialFocus?: number | RefObject<HTMLElement | null>;
  /** Return focus to the anchor when closing (default true). */
  returnFocus?: boolean;
  /** Close when focus leaves the panel (default true). */
  closeOnFocusOut?: boolean;
  /** ARIA role of the panel (default 'dialog'; 'none' when the content brings its own, e.g. a <Menu>). */
  role?: 'dialog' | 'menu' | 'listbox' | 'none';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-testid'?: string;
}

interface PopoverCtx {
  /** Close this popover. */
  close: () => void;
  /** Close this popover and every ancestor popover (menu item selected). */
  closeAll: () => void;
}

const PopoverContext = createContext<PopoverCtx | null>(null);

/** Inside popover content: close helpers (null outside any popover). */
export function usePopoverClose(): PopoverCtx | null {
  return useContext(PopoverContext);
}

function isRefObject(a: PopoverAnchor): a is RefObject<Element | null> {
  return a != null && typeof a === 'object' && 'current' in a;
}

const ORIGIN: Record<string, string> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

function transformOrigin(placement: Placement): string {
  const [side = 'bottom', align] = placement.split('-');
  const vertical = side === 'top' || side === 'bottom';
  const main = ORIGIN[side] ?? 'top';
  const cross = align === 'start' ? (vertical ? 'left' : 'top') : align === 'end' ? (vertical ? 'right' : 'bottom') : 'center';
  return vertical ? `${cross} ${main}` : `${main} ${cross}`;
}

/**
 * Notion popover: portaled, flips/shifts on screen, closes on outside press and Escape (topmost first),
 * 120ms fade + scale(.98) from the anchor side. Nested popovers form a tree (pressing inside a child
 * doesn't close the parent).
 */
export function Popover(props: PopoverProps) {
  const parentId = useFloatingParentNodeId();
  if (parentId === null) {
    return (
      <FloatingTree>
        <PopoverImpl {...props} />
      </FloatingTree>
    );
  }
  return <PopoverImpl {...props} />;
}

function PopoverImpl({
  open,
  onOpenChange,
  anchor,
  placement = 'bottom-start',
  offset = 4,
  children,
  className,
  style,
  width,
  matchAnchorWidth,
  initialFocus = 0,
  returnFocus = true,
  closeOnFocusOut = true,
  role = 'dialog',
  ...aria
}: PopoverProps) {
  const nodeId = useFloatingNodeId();
  const parent = useContext(PopoverContext);

  const { refs, floatingStyles, context, placement: finalPlacement, isPositioned } = useFloating({
    nodeId,
    open,
    onOpenChange,
    placement,
    strategy: 'fixed',
    middleware: [
      offsetMw(offset),
      flip({ padding: 8, fallbackAxisSideDirection: 'end' }),
      shift({ padding: 8 }),
      sizeMw({
        padding: 8,
        apply({ availableHeight, rects, elements }) {
          elements.floating.style.setProperty('--popover-max-h', `${Math.max(120, Math.floor(availableHeight))}px`);
          if (matchAnchorWidth) elements.floating.style.minWidth = `${Math.round(rects.reference.width)}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Resolve the anchor (ref → element) whenever it may have changed; virtual anchors position only.
  useLayoutEffect(() => {
    const a = isRefObject(anchor) ? anchor.current : anchor;
    if (!a) return;
    if (a instanceof Element) refs.setReference(a);
    else refs.setPositionReference(a);
  }, [anchor, open, refs]);

  const dismiss = useDismiss(context, { escapeKey: false, outsidePress: true });
  const roleProps = useRole(context, { role: role === 'none' ? 'dialog' : role, enabled: role !== 'none' });
  const { getFloatingProps } = useInteractions([dismiss, roleProps]);

  const { depth } = useLayer(open, () => onOpenChange(false));

  const ctx = useMemo<PopoverCtx>(
    () => ({
      close: () => onOpenChange(false),
      closeAll: () => {
        onOpenChange(false);
        parent?.closeAll();
      },
    }),
    [onOpenChange, parent],
  );

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: DUR_MS.fast, close: DUR_MS.instant },
    initial: { opacity: 0, transform: 'scale(0.98)' },
    common: ({ placement: p }) => ({
      transformOrigin: transformOrigin(p),
      transitionTimingFunction: 'var(--ease)',
    }),
  });

  const panelStyle: CSSProperties = {
    ...style,
    ...(width != null ? { width: typeof width === 'number' ? `${width}px` : width } : null),
    ...transitionStyles,
  };

  if (!isMounted) return <FloatingNode id={nodeId}>{null}</FloatingNode>;

  return (
    <FloatingNode id={nodeId}>
      <FloatingPortal>
        <FloatingFocusManager
          context={context}
          modal={false}
          initialFocus={initialFocus}
          returnFocus={returnFocus}
          closeOnFocusOut={closeOnFocusOut}
        >
          <div
            ref={refs.setFloating}
            className={styles.positioner}
            data-scroll-lock-allow=""
            data-placement={finalPlacement}
            aria-label={aria['aria-label']}
            aria-labelledby={aria['aria-labelledby']}
            style={{
              ...floatingStyles,
              // No flash at (0,0) before the first position is computed (opacity, not visibility, so the
              // content can take focus immediately); no clicks while fading out.
              opacity: open && !isPositioned ? 0 : undefined,
              pointerEvents: open ? undefined : 'none',
            }}
            {...getFloatingProps()}
          >
            <div
              className={cx(styles.panel, className)}
              style={panelStyle}
              data-testid={aria['data-testid']}
            >
              <PopoverContext.Provider value={ctx}>
                <LayerDepthContext.Provider value={depth}>{children}</LayerDepthContext.Provider>
              </PopoverContext.Provider>
            </div>
          </div>
        </FloatingFocusManager>
      </FloatingPortal>
    </FloatingNode>
  );
}
