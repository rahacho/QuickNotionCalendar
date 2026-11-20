import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { renameTask } from '@/store/actions';
import { cx } from '@/lib/cx';
import styles from './TitleEditor.module.css';

export interface TitleEditorProps {
  taskId: string;
  /** The saved title (store). */
  title: string;
  /** 'peek' = 32px desktop title; 'sheet' = 26px phone title. */
  size: 'peek' | 'sheet';
  id?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Filled with a function that saves any pending edit right away (call before closing). */
  flushRef?: MutableRefObject<(() => void) | null>;
}

const COMMIT_DELAY = 500;
const MAX_LEN = 500;

/** Single-line title: newlines (from paste or IME) become spaces. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/**
 * Notion page title: an auto-growing textarea (wraps, never scrolls), placeholder "Untitled".
 * Enter finishes editing. Saves 500ms after typing pauses, on blur, and always on unmount/close
 * (flushRef). An empty title is never saved — blur restores the last saved one. Remote renames
 * show up whenever the field isn't being edited.
 */
export function TitleEditor({ taskId, title, size, id, inputRef, flushRef }: TitleEditorProps) {
  const [draft, setDraft] = useState(title);
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef(false);
  const latest = useRef({ taskId, title, draft });
  latest.current = { taskId, title, draft };

  const setRefs = (el: HTMLTextAreaElement | null) => {
    localRef.current = el;
    if (inputRef) (inputRef as MutableRefObject<HTMLTextAreaElement | null>).current = el;
  };

  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (!pending.current) return;
    pending.current = false;
    const { taskId: id, title: saved, draft: text } = latest.current;
    const next = text.trim();
    if (next !== '' && next !== saved) renameTask(id, next);
  };

  // Expose the latest flush to the peek (re-attached after every render, StrictMode-safe).
  useLayoutEffect(() => {
    if (!flushRef) return;
    flushRef.current = flush;
    return () => {
      if (flushRef.current === flush) flushRef.current = null;
    };
  });

  // Remote/other edits replace the text only while the user isn't typing here.
  useEffect(() => {
    if (!focused.current && !pending.current) setDraft(title);
  }, [title]);

  // Always save on unmount (peek closed, task switched).
  useEffect(
    () => () => flush(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Auto-grow to fit the wrapped text.
  const fit = () => {
    const el = localRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [draft, size]);
  useEffect(() => {
    const el = localRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit); // outside the observer callback: no RO loop warnings
    });
    ro.observe(el);
    // Web fonts / late layout can change wrapping after mount.
    raf = requestAnimationFrame(fit);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      ref={setRefs}
      id={id}
      className={cx(styles.title, size === 'sheet' && styles.sheet)}
      value={draft}
      rows={1}
      maxLength={MAX_LEN}
      placeholder="Untitled"
      aria-label="Task name"
      spellCheck
      autoCapitalize="sentences"
      enterKeyHint="done"
      data-testid="peek-title"
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        const v = oneLine(e.target.value);
        setDraft(v);
        latest.current.draft = v;
        pending.current = true;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, COMMIT_DELAY);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        focused.current = false;
        const hadEdits = pending.current;
        flush();
        const text = latest.current.draft.trim();
        // No local edits (or emptied) → show the saved title, which may have changed remotely meanwhile.
        setDraft(!hadEdits || text === '' ? latest.current.title : text);
      }}
    />
  );
}
