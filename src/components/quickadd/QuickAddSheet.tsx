import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, X } from 'lucide-react';
import type { ISODate, Occurrence } from '@shared/types';
import { formatWeekdayShort } from '@shared/format';
import { isOverdue, refOf } from '@shared/occurrences';
import { useStore } from '@/store/store';
import { useOccurrencesInRange } from '@/store/selectors';
import { closeComposer, createTask, createTasksFromText, deleteTask, openPeek, showToast } from '@/store/actions';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { DUR, EASE } from '@/lib/motion';
import { cx } from '@/lib/cx';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { Icon } from '@/components/ui/Icon';
import { TaskCard } from '@/components/card/TaskCard';
import styles from './QuickAddSheet.module.css';

interface Draft {
  date: ISODate;
  text: string;
}

/**
 * Phone quick add (tap an empty part of a day): a sheet titled "New task" with the day as subtitle,
 * an autofocused field (Enter creates and clears for the next one; a multi-line paste creates one
 * task per line) and, below, what's already planned that day.
 *
 * A typed name is never thrown away. Like the desktop composer's blur-with-text, every other way of
 * leaving — ✕, tapping the dimmed calendar, swiping the sheet down, Esc, opening a planned task, the
 * composer closing or moving to another day from elsewhere, the layout leaving phone, unmounting —
 * creates the task on its day and confirms it with an "Added to … · Undo" toast.
 */
export function QuickAddSheet() {
  const composer = useStore((s) => s.ui.composer);
  const phone = useLayoutMode() === 'phone';
  const titleId = useId();
  const lastDate = useRef<ISODate | null>(null);
  if (composer) lastDate.current = composer.date;
  const date = composer?.date ?? lastDate.current;
  const open = composer !== null && phone;

  // The field's text lives here (tagged with its day) so the close paths below can read it.
  const [input, setInput] = useState<Draft | null>(null);
  const pending = useRef<Draft | null>(null);

  const setText = useCallback((forDate: ISODate, text: string) => {
    pending.current = text.trim() ? { date: forDate, text } : null;
    setInput(text ? { date: forDate, text } : null);
  }, []);

  /** Creates the typed-but-not-added task, if any (at most once), and clears the field. */
  const keepDraft = useCallback((clearField = true) => {
    const d = pending.current;
    pending.current = null;
    if (clearField) setInput(null);
    if (!d) return;
    const id = createTask({ title: d.text, date: d.date });
    if (id) {
      showToast(`Added to ${formatWeekdayShort(d.date)}`, { action: { label: 'Undo', run: () => deleteTask(id) } });
    }
  }, []);

  const close = useCallback(() => {
    keepDraft();
    closeComposer();
  }, [keepDraft]);

  const openTask = useCallback(
    (occ: Occurrence) => {
      keepDraft();
      closeComposer();
      openPeek(refOf(occ));
    },
    [keepDraft],
  );

  // Safety nets: closed from elsewhere (store, layout change), moved to another day, unmounted.
  useEffect(() => {
    if (!open) keepDraft();
  }, [open, keepDraft]);
  useEffect(() => {
    if (pending.current && pending.current.date !== date) keepDraft();
  }, [date, keepDraft]);
  useEffect(() => () => keepDraft(false), [keepDraft]);

  return (
    <Sheet open={open} onClose={close} labelledBy={titleId} data-testid="quickadd">
      {date && (
        <QuickAddBody
          key={date}
          date={date}
          titleId={titleId}
          text={input && input.date === date ? input.text : ''}
          onTextChange={(text) => setText(date, text)}
          onClose={close}
          onOpenTask={openTask}
        />
      )}
    </Sheet>
  );
}

interface QuickAddBodyProps {
  date: ISODate;
  titleId: string;
  text: string;
  onTextChange: (text: string) => void;
  onClose: () => void;
  onOpenTask: (occ: Occurrence) => void;
}

function QuickAddBody({ date, titleId, text, onTextChange: setText, onClose, onOpenTask }: QuickAddBodyProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const occs = useOccurrencesInRange(date, date);
  const today = useStore((s) => s.today);
  const canAdd = text.trim() !== '';

  const add = () => {
    if (!canAdd) return;
    if (createTask({ title: text, date })) setText('');
    inputRef.current?.focus({ preventScroll: true });
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!/[\r\n]/.test(pasted)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startSel = el.selectionStart ?? text.length;
    const endSel = el.selectionEnd ?? text.length;
    const combined = text.slice(0, startSel) + pasted + text.slice(endSel);
    if (createTasksFromText(combined, date).length > 0) setText('');
  };

  return (
    <div className={styles.body}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={titleId} className={styles.title}>
            New task
          </h2>
          <p className={styles.subtitle}>{formatWeekdayShort(date)}</p>
        </div>
        <IconButton label="Close" icon={X} onClick={onClose} data-testid="quickadd-close" />
      </header>

      <form
        className={styles.inputRow}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          value={text}
          placeholder="Task name"
          autoFocus
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="enter"
          maxLength={500}
          aria-label="Task name"
          data-testid="quickadd-input"
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
        />
        <button
          type="submit"
          className={cx(styles.addBtn, canAdd && styles.addBtnReady)}
          disabled={!canAdd}
          aria-label="Add task"
          onMouseDown={(e) => e.preventDefault()}
          data-testid="quickadd-add"
        >
          <Icon icon={ArrowUp} size={16} strokeWidth={2.25} />
        </button>
      </form>

      <div className={styles.planned}>
        <div className={styles.plannedLabel}>
          {occs.length > 0 ? `Planned · ${occs.length}` : 'Nothing planned yet'}
        </div>
        <div className={styles.list}>
          <AnimatePresence initial={false}>
            {occs.map((occ) => (
              <motion.div
                key={occ.key}
                layout="position"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: DUR.base, ease: EASE }}
                className={styles.item}
              >
                <TaskCard
                  occ={occ}
                  variant="inbox"
                  overdue={isOverdue(occ, today)}
                  data-testid="quickadd-task"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenTask(occ)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenTask(occ);
                    }
                  }}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
