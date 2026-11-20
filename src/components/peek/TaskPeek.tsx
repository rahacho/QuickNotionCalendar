import { useEffect, useId, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { Bell, Calendar, Clock, Copy, Ellipsis, Inbox, Repeat, SquareCheck, Trash2, X } from 'lucide-react';
import type { Occurrence, OccurrenceRef } from '@shared/types';
import { isOverdue } from '@shared/occurrences';
import { describeRecurrence } from '@shared/recurrence';
import { useStore } from '@/store/store';
import { useOccurrence } from '@/store/selectors';
import {
  closePeek,
  deleteOccurrence,
  deleteTask,
  duplicateTask,
  moveOccurrence,
  setDone,
  showToast,
} from '@/store/actions';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { cx } from '@/lib/cx';
import { Modal } from '@/components/ui/Modal';
import { Sheet } from '@/components/ui/Sheet';
import { Popover } from '@/components/ui/Popover';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { IconButton } from '@/components/ui/IconButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { DatePickerPopover } from '@/components/pickers/DatePicker';
import { RepeatEditor } from '@/components/pickers/RepeatEditor';
import { ReminderMenu } from '@/components/pickers/ReminderMenu';
import { formatOccurrenceDate, formatTimestamp, reminderValueLabel } from '@/components/pickers/pickerUtils';
import { PropertyRow } from './PropertyRow';
import { TitleEditor } from './TitleEditor';
import { EditorSurface } from './EditorSurface';
import styles from './TaskPeek.module.css';

type Editor = 'date' | 'repeat' | 'remind' | 'menu' | 'delete';

/**
 * Notion center peek for the occurrence in store.ui.peek (phone: a bottom sheet with the same
 * content). Title + Date / Repeat / Remind / Done / Created, ⋯ menu, Move to Inbox, Delete.
 * If the occurrence disappears (deleted on another device, its date skipped…) the peek closes,
 * animating out with the last thing it showed.
 */
export function TaskPeek() {
  const peek = useStore((s) => s.ui.peek);
  const occ = useOccurrence(peek);
  const layout = useLayoutMode();
  const phone = layout === 'phone';
  const titleId = useId();
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const flushRef = useRef<(() => void) | null>(null);
  const lastOcc = useRef<Occurrence | null>(null);
  if (occ) lastOcc.current = occ;
  const shown = occ ?? lastOcc.current;
  const open = peek !== null && occ !== null;

  // The occurrence vanished under us (remote delete, skipped elsewhere): close gracefully.
  useEffect(() => {
    if (peek !== null && occ === null) closePeek();
  }, [peek, occ]);

  const close = () => {
    flushRef.current?.();
    closePeek();
  };

  const focusTitle = shown !== null && shown.title.trim() === '';
  const body = shown ? (
    <PeekBody
      key={shown.taskId}
      occ={shown}
      variant={phone ? 'sheet' : 'peek'}
      onClose={close}
      titleId={titleId}
      titleRef={titleRef}
      flushRef={flushRef}
    />
  ) : null;

  return (
    <>
      <Modal
        open={open && !phone}
        onClose={close}
        labelledBy={titleId}
        initialFocusRef={focusTitle ? titleRef : undefined}
        data-testid="peek"
      >
        {body}
      </Modal>
      <Sheet
        open={open && phone}
        onClose={close}
        labelledBy={titleId}
        initialFocusRef={focusTitle ? titleRef : undefined}
        data-testid="peek"
      >
        {body}
      </Sheet>
    </>
  );
}

interface PeekBodyProps {
  occ: Occurrence;
  variant: 'peek' | 'sheet';
  onClose: () => void;
  titleId: string;
  titleRef: RefObject<HTMLTextAreaElement | null>;
  flushRef: MutableRefObject<(() => void) | null>;
}

function PeekBody({ occ, variant, onClose, titleId, titleRef, flushRef }: PeekBodyProps) {
  const today = useStore((s) => s.today);
  const [editor, setEditor] = useState<Editor | null>(null);
  const dateRef = useRef<HTMLElement>(null);
  const repeatRef = useRef<HTMLElement>(null);
  const remindRef = useRef<HTMLElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const deleteBtn = useRef<HTMLButtonElement>(null);

  const task = occ.task;
  const ref: OccurrenceRef = { taskId: occ.taskId, origDate: occ.origDate };
  const inbox = occ.date === null;
  const recurring = occ.recurring;
  const timed = occ.time != null;
  const overdue = isOverdue(occ, today);

  const dateText = inbox ? 'Empty' : formatOccurrenceDate(occ);
  const repeatText = task.recurrence && task.date ? describeRecurrence(task.recurrence, task.date) : 'Never';
  const remindText = reminderValueLabel(task.reminder, timed);

  const openEditor = (e: Editor) => setEditor((cur) => (cur === e ? null : e));
  const editorProps = (e: Editor) => ({
    open: editor === e,
    onOpenChange: (o: boolean) => setEditor((cur) => (o ? e : cur === e ? null : cur)),
  });

  const flush = () => flushRef.current?.();
  const duplicate = () => {
    flush();
    if (duplicateTask(task.id)) showToast('Task duplicated');
  };
  const toInbox = () => {
    flush();
    moveOccurrence(ref, null);
  };
  const removeThis = () => {
    flush();
    deleteOccurrence(ref);
  };
  const removeAll = () => {
    flush();
    deleteTask(task.id);
  };

  const sheet = variant === 'sheet';

  return (
    <div className={cx(styles.body, sheet && styles.sheet)}>
      <div className={styles.topbar}>
        <IconButton
          ref={menuBtn}
          label="More actions"
          icon={Ellipsis}
          active={editor === 'menu'}
          aria-haspopup="menu"
          aria-expanded={editor === 'menu'}
          onClick={() => openEditor('menu')}
          className={styles.topButton}
          data-testid="peek-menu"
        />
        <IconButton label="Close" hint="Esc" icon={X} onClick={onClose} className={styles.topButton} data-testid="peek-close" />
      </div>

      <div className={styles.content}>
        <TitleEditor
          taskId={task.id}
          title={occ.title}
          size={sheet ? 'sheet' : 'peek'}
          id={titleId}
          inputRef={titleRef}
          flushRef={flushRef}
        />

        <div className={styles.props}>
          <PropertyRow
            ref={dateRef}
            icon={Calendar}
            label="Date"
            empty={inbox}
            tone={overdue ? 'danger' : 'default'}
            active={editor === 'date'}
            onClick={() => openEditor('date')}
            aria-haspopup="dialog"
            data-testid="peek-date"
          >
            {dateText}
          </PropertyRow>
          <PropertyRow
            ref={repeatRef}
            icon={Repeat}
            label="Repeat"
            empty={!task.recurrence}
            active={editor === 'repeat'}
            disabled={occ.multiDay}
            disabledReason="Multi-day tasks can’t repeat"
            onClick={() => openEditor('repeat')}
            aria-haspopup="menu"
            data-testid="peek-repeat"
          >
            {repeatText}
          </PropertyRow>
          <PropertyRow
            ref={remindRef}
            icon={Bell}
            label="Remind"
            empty={remindText === 'None'}
            active={editor === 'remind'}
            onClick={() => openEditor('remind')}
            aria-haspopup="menu"
            data-testid="peek-remind"
          >
            {remindText}
          </PropertyRow>
          <PropertyRow icon={SquareCheck} label="Done" kind="box" onClick={() => setDone(ref, !occ.done)}>
            <Checkbox checked={occ.done} onChange={(v) => setDone(ref, v)} hitArea="large" aria-label="Done" data-testid="peek-done" />
          </PropertyRow>
          <PropertyRow icon={Clock} label="Created" kind="static" data-testid="peek-created">
            {formatTimestamp(task.createdAt)}
          </PropertyRow>
        </div>

        <div className={styles.divider} role="separator" />

        <div className={styles.actions}>
          {!recurring && !inbox && (
            <button type="button" className={styles.action} onClick={toInbox} data-testid="peek-move-inbox">
              <Icon icon={Inbox} size={16} className={styles.actionIcon} />
              <span>Move to Inbox</span>
            </button>
          )}
          <button
            ref={deleteBtn}
            type="button"
            className={cx(styles.action, styles.danger, editor === 'delete' && styles.actionActive)}
            aria-haspopup={recurring ? 'menu' : undefined}
            aria-expanded={recurring ? editor === 'delete' : undefined}
            onClick={recurring ? () => openEditor('delete') : removeThis}
            data-testid="peek-delete"
          >
            <Icon icon={Trash2} size={16} className={styles.actionIcon} />
            <span>Delete</span>
          </button>
        </div>
      </div>

      <DatePickerPopover {...editorProps('date')} anchor={dateRef} occ={occ} />

      <EditorSurface {...editorProps('repeat')} anchor={repeatRef} phone={sheet} title="Repeat" data-testid="repeat-menu">
        <RepeatEditor occ={occ} onDone={() => setEditor(null)} />
      </EditorSurface>

      <EditorSurface {...editorProps('remind')} anchor={remindRef} phone={sheet} title="Remind" data-testid="remind-menu">
        <ReminderMenu occ={occ} onDone={() => setEditor(null)} />
      </EditorSurface>

      <Popover {...editorProps('menu')} anchor={menuBtn} placement="bottom-end" role="none" width={240} data-testid="peek-menu-popover">
        <Menu aria-label="Task actions">
          <MenuItem icon={Copy} label="Duplicate" onSelect={duplicate} data-testid="peek-menu-duplicate" />
          {!recurring && !inbox && (
            <MenuItem icon={Inbox} label="Move to Inbox" onSelect={toInbox} data-testid="peek-menu-move-inbox" />
          )}
          <MenuSeparator />
          {recurring ? (
            <>
              <MenuItem icon={Trash2} label="Delete this occurrence" danger onSelect={removeThis} data-testid="peek-menu-delete-occurrence" />
              <MenuItem icon={Trash2} label="Delete all repeats" danger onSelect={removeAll} data-testid="peek-menu-delete-all" />
            </>
          ) : (
            <MenuItem icon={Trash2} label="Delete" danger onSelect={removeThis} data-testid="peek-menu-delete" />
          )}
        </Menu>
      </Popover>

      <Popover {...editorProps('delete')} anchor={deleteBtn} placement="bottom-start" role="none" width={240} data-testid="peek-delete-menu">
        <Menu aria-label="Delete">
          <MenuItem icon={Trash2} label="Delete this occurrence" danger onSelect={removeThis} data-testid="peek-delete-occurrence" />
          <MenuItem icon={Trash2} label="Delete all repeats" danger onSelect={removeAll} data-testid="peek-delete-all" />
        </Menu>
      </Popover>
    </div>
  );
}
