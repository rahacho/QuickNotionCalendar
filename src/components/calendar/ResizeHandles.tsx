import { memo, type MouseEvent, type PointerEvent } from 'react';
import type { Occurrence } from '@shared/types';
import { beginResize } from './resize';
import styles from './Calendar.module.css';

const stop = (e: MouseEvent) => {
  // Keep dnd-kit's mouse sensor (on the card) from seeing the press, and the card from opening.
  e.stopPropagation();
};

const stopClick = (e: MouseEvent) => {
  e.stopPropagation();
  e.preventDefault();
};

/** 6px ew-resize edges (desktop, fine pointer). `start`/`end` can be hidden on continuing segments. */
export const ResizeHandles = memo(function ResizeHandles({ occ, start = true, end = true }: { occ: Occurrence; start?: boolean; end?: boolean }) {
  return (
    <>
      {start && (
        <span
          className={`${styles.handle} ${styles.handleStart}`}
          data-testid="resize-start"
          aria-hidden="true"
          onPointerDown={(e: PointerEvent) => beginResize(e, occ, 'start')}
          onMouseDown={stop}
          onClick={stopClick}
          onDoubleClick={stopClick}
        />
      )}
      {end && (
        <span
          className={`${styles.handle} ${styles.handleEnd}`}
          data-testid="resize-end"
          aria-hidden="true"
          onPointerDown={(e: PointerEvent) => beginResize(e, occ, 'end')}
          onMouseDown={stop}
          onClick={stopClick}
          onDoubleClick={stopClick}
        />
      )}
    </>
  );
});
