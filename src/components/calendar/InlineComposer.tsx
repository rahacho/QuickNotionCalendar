import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { ISODate } from '@shared/types';
import { formatDateLong } from '@shared/format';
import { useStore } from '@/store/store';
import { closeComposer, createTask, createTasksFromText } from '@/store/actions';
import styles from './Calendar.module.css';

/** Mounted composers per date (a view switch may unmount one cell's composer and mount another's). */
const mounted = new Map<ISODate, number>();

/**
 * Notion-style inline "new page" card at the bottom of a day (desktop / tablet).
 * Enter creates the task and keeps a fresh input open for the next one; Esc closes; blurring with
 * text creates it, blurring empty just closes. A multi-line paste creates one task per line.
 */
export function InlineComposer({ date }: { date: ISODate }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const valueRef = useRef('');

  const setText = useCallback((v: string) => {
    valueRef.current = v;
    setValue(v);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    // Bring the composer into view inside the calendar scroller only (scrollIntoView would also
    // scroll the overflow-hidden app frame).
    const sc = el.closest<HTMLElement>('[data-cal-scroller]');
    if (sc) {
      const r = el.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      if (r.bottom > sr.bottom - 8) sc.scrollTop += r.bottom - sr.bottom + 8;
    }
  }, []);

  // Auto-grow: the full name is always visible, like a card.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // Unmounted with text (the day scrolled out of the mounted window, view switched…) → keep it.
  // If no composer for this day is mounted again right after (StrictMode remounts, a view switch
  // re-renders the same day), close it too, so it doesn't reappear when the day scrolls back in.
  useEffect(() => {
    mounted.set(date, (mounted.get(date) ?? 0) + 1);
    return () => {
      mounted.set(date, (mounted.get(date) ?? 1) - 1);
      const t = valueRef.current.trim();
      valueRef.current = '';
      if (t) createTask({ title: t, date });
      window.setTimeout(() => {
        if ((mounted.get(date) ?? 0) > 0) return;
        mounted.delete(date);
        if (useStore.getState().ui.composer?.date === date) closeComposer();
      }, 0);
    };
  }, [date]);

  const commit = useCallback(() => {
    const t = valueRef.current.trim();
    setText('');
    if (t) createTask({ title: t, date });
  }, [date, setText]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setText('');
      closeComposer();
    }
  };

  const onBlur = () => {
    // Switching apps/tabs blurs too: keep the composer (focus comes back with the window).
    if (!document.hasFocus()) return;
    commit();
    closeComposer();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!/\r|\n/.test(text)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const before = valueRef.current.slice(0, el.selectionStart);
    const after = valueRef.current.slice(el.selectionEnd);
    setText('');
    createTasksFromText(`${before}${text}${after}`, date);
  };

  return (
    <div className={styles.composer}>
      <textarea
        ref={ref}
        className={styles.composerInput}
        rows={1}
        value={value}
        placeholder="Untitled"
        aria-label={`New task on ${formatDateLong(date)}`}
        data-testid="composer-input"
        enterKeyHint="done"
        maxLength={500}
        spellCheck
        onChange={(e) => setText(e.target.value.replace(/\r?\n/g, ' '))}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onPaste={onPaste}
      />
    </div>
  );
}
