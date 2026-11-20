import { forwardRef, memo } from 'react';
import styles from './Calendar.module.css';

const LONG = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Sticky "Mon … Sun" row (phone: "M T W …"), rotated for the week-start setting. */
export const WeekdayHeader = memo(
  forwardRef<HTMLDivElement, { weekStart: 0 | 1; compact: boolean }>(function WeekdayHeader({ weekStart, compact }, ref) {
    const names = compact ? SHORT : LONG;
    const cols: string[] = [];
    for (let i = 0; i < 7; i++) cols.push(names[(weekStart + i) % 7] as string);
    return (
      <div ref={ref} className={styles.weekdays} aria-hidden="true">
        {cols.map((n, i) => (
          <span key={i}>{n}</span>
        ))}
      </div>
    );
  }),
);
