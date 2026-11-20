import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useMergeRefs } from '@floating-ui/react';
import type { HM } from '@shared/types';
import { hmToMinutes, isHM, minutesToHM } from '@shared/dates';
import { formatTime, parseTimeInput } from '@shared/format';
import { cx } from '@/lib/cx';
import { Popover } from '@/components/ui/Popover';
import { shake } from './pickerUtils';
import styles from './TimeInput.module.css';

export interface TimeInputProps {
  value: HM | null;
  onChange: (time: HM) => void;
  placeholder?: string;
  /** Minutes between suggestions in the dropdown (default 30). */
  step?: number;
  /** Show the scrollable list of times while focused (default true). */
  showList?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Outer field box. */
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * Notion time field: type "3pm", "15:30", "930"… (parseTimeInput) — Enter or blur applies, an
 * unreadable entry shakes and reverts. While focused a list of times (every 30 min) drops down:
 * ↑/↓ walk it, click or Enter picks. The ref points at the <input>.
 */
export const TimeInput = forwardRef<HTMLInputElement, TimeInputProps>(function TimeInput(
  {
    value,
    onChange,
    placeholder = 'Add time',
    step = 30,
    showList = true,
    disabled,
    autoFocus,
    className,
    'aria-label': ariaLabel = 'Time',
    'data-testid': testId,
  },
  ref,
) {
  const shown = value && isHM(value) ? formatTime(value) : '';
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const navigated = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mergedRef = useMergeRefs([inputRef, ref]);
  const listId = useId();
  const safeStep = Number.isInteger(step) && step >= 5 && step <= 720 && 1440 % step === 0 ? step : 30;

  const slots = useMemo(() => Array.from({ length: 1440 / safeStep }, (_, i) => minutesToHM(i * safeStep)), [safeStep]);

  // Show the committed value whenever the user isn't typing (also picks up remote edits).
  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [shown, editing]);

  const indexNear = (t: HM | null): number => {
    const m = t && isHM(t) ? hmToMinutes(t) : 9 * 60;
    return Math.min(slots.length - 1, Math.max(0, Math.floor(m / safeStep)));
  };

  // Keep the highlighted time in view (centered when the list opens).
  const justOpened = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-index="${hi}"]`);
    if (!list || !item) return;
    if (justOpened.current) {
      justOpened.current = false;
      list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
    } else {
      const top = item.offsetTop;
      const bottom = top + item.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
  }, [open, hi]);

  const openList = () => {
    if (!showList || disabled) return;
    justOpened.current = true;
    setHi(indexNear(parseTimeInput(draft) ?? value));
    setOpen(true);
  };

  const apply = (t: HM) => {
    setDraft(formatTime(t));
    if (t !== value) onChange(t);
  };

  /** Enter: picks the highlighted time after ↑/↓, else parses the text. */
  const commit = (): boolean => {
    if (navigated.current && open && slots[hi]) {
      apply(slots[hi] as HM);
      return true;
    }
    const t = parseTimeInput(draft);
    if (t) {
      apply(t);
      return true;
    }
    if (draft.trim() === '' && value === null) return true;
    shake(fieldRef.current);
    setDraft(shown);
    return false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!showList) return;
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      navigated.current = true;
      setHi((i) => {
        const next = Math.max(0, Math.min(slots.length - 1, (i < 0 ? indexNear(value) : i) + (e.key === 'ArrowDown' ? 1 : -1)));
        const slot = slots[next];
        if (slot) setDraft(formatTime(slot));
        return next;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (commit()) {
        navigated.current = false;
        setOpen(false);
      }
    }
  };

  return (
    <div ref={fieldRef} className={cx(styles.field, open && styles.focused, disabled && styles.disabled, className)}>
      <input
        ref={mergedRef}
        type="text"
        inputMode="text"
        className={styles.input}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && hi >= 0 ? `${listId}-${hi}` : undefined}
        data-testid={testId}
        onFocus={(e) => {
          setEditing(true);
          navigated.current = false;
          e.currentTarget.select();
          openList();
        }}
        onMouseDown={() => {
          // Re-open after picking (focus stays in the field).
          if (document.activeElement === inputRef.current && !open) openList();
        }}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          navigated.current = false;
          const t = parseTimeInput(v);
          if (t && open) setHi(indexNear(t));
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setEditing(false);
          setOpen(false);
          navigated.current = false;
          const t = parseTimeInput(draft);
          if (t) apply(t);
          else setDraft(shown);
        }}
      />
      <Popover
        open={open}
        onOpenChange={(o) => {
          if (!o) setOpen(false);
        }}
        anchor={fieldRef}
        placement="bottom-start"
        initialFocus={-1}
        returnFocus={false}
        closeOnFocusOut={false}
        role="none"
        matchAnchorWidth
        className={styles.popover}
      >
        <div ref={listRef} id={listId} role="listbox" aria-label="Times" className={styles.list}>
          {slots.map((t, i) => (
            <div
              key={t}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={t === value}
              data-index={i}
              className={cx(styles.option, i === hi && styles.highlighted, t === value && styles.current)}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => {
                if (hi !== i) setHi(i);
              }}
              onClick={() => {
                apply(t);
                navigated.current = false;
                setOpen(false);
              }}
            >
              {formatTime(t)}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  );
});
