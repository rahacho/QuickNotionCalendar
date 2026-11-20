import type { ISODate, Occurrence } from '@shared/types';
import type { DragSource } from '@/store/store';

export const dragIds = {
  cal: (occKey: string): string => `cal:${occKey}`,
  inbox: (taskId: string): string => `inbox:${taskId}`,
  list: (occKey: string): string => `list:${occKey}`,
};

export const containerIds = {
  inbox: 'inbox' as const,
  day: (date: ISODate): string => `day:${date}`,
};

export interface TaskDragData {
  kind: 'task';
  occ: Occurrence;
  source: DragSource;
  containerId: string | null;
}

export function isTaskDragData(d: unknown): d is TaskDragData {
  return d != null && typeof d === 'object' && (d as { kind?: unknown }).kind === 'task' && 'occ' in d;
}
