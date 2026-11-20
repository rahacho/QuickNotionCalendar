import { forwardRef, useState, type ClipboardEvent, type FocusEventHandler, type KeyboardEvent } from 'react';
import { createTask, createTasksFromText } from '@/store/actions';
import { TextInput } from '@/components/ui/TextInput';
import styles from './Inbox.module.css';

export interface InboxInputProps {
  /** Called after one or more tasks were created (e.g. to scroll the list back to the top). */
  onCreated?: () => void;
  onFocus?: FocusEventHandler<HTMLInputElement>;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  className?: string;
}

const MULTILINE = /[\r\n\u2028\u2029]/;

/**
 * "Type a task, press Enter" — the brain-dump field at the top of the Inbox.
 *  - Enter creates the task at the top of the Inbox and keeps focus for rapid entry (iOS keyboard stays up).
 *  - Pasting several lines creates one task per line (bullets stripped), in line order.
 *  - Esc blurs. Enter while an IME is composing (Japanese, Chinese, …) is left to the IME.
 */
export const InboxInput = forwardRef<HTMLInputElement, InboxInputProps>(function InboxInput(
  { onCreated, onFocus, onBlur, className },
  ref,
) {
  const [value, setValue] = useState('');

  const submit = () => {
    if (value.trim() === '') return;
    const id = createTask({ title: value, date: null });
    if (id) {
      setValue('');
      onCreated?.();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      if (e.nativeEvent.isComposing) return;
      e.currentTarget.blur();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain');
    // Single line (or one line + trailing newline): let the browser paste it normally.
    if (!MULTILINE.test(text.replace(/^[\r\n]+|[\r\n]+$/g, ''))) return;
    e.preventDefault();
    const input = e.currentTarget;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    // Whatever was already typed joins the pasted block exactly where the caret was.
    const combined = value.slice(0, start) + text + value.slice(end);
    const ids = createTasksFromText(combined, null);
    if (ids.length > 0) {
      setValue('');
      onCreated?.();
    }
  };

  return (
    <TextInput
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      onBlur={onBlur}
      placeholder="Type a task, press Enter"
      aria-label="New Inbox task"
      data-testid="inbox-input"
      enterKeyHint="enter"
      autoCapitalize="sentences"
      maxLength={500}
      className={className}
      inputClassName={styles.inputText}
    />
  );
});
