import 'fake-indexeddb/auto';
import type { ISODate, Settings, Task } from '@shared/types';
import { createLocalRepo, type LocalRepo } from '@/data/localRepo';
import { connectRepo } from '@/data/boot';
import { createInitialState, useStore } from '@/store/store';
import { clearUndo } from '@/store/undo';

let ns = 0;

/** Polls `fn` (macrotask ticks) until it returns true; throws after `timeoutMs`. */
export async function until(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(): timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

export interface Harness {
  repo: LocalRepo;
  disconnect: () => void;
  namespace: string;
}

const open: Harness[] = [];

/**
 * Fresh store + a fresh LocalRepo (unique IndexedDB namespace) connected like boot.ts does.
 * Resolves once tasks and the user doc have loaded; then pins today/settings for determinism.
 */
export async function setup(opts?: { today?: ISODate; timezone?: string }): Promise<Harness> {
  clearUndo();
  useStore.setState(createInitialState(), true);
  useStore.setState({ mode: 'local', authReady: true, user: { uid: 'local', email: null } });
  const namespace = `test-${Date.now()}-${++ns}-${Math.random().toString(36).slice(2)}`;
  const repo = createLocalRepo(namespace);
  let userLoaded = false;
  const unsubUser = repo.subscribeUser(() => {
    userLoaded = true;
  }, () => undefined);
  const disconnect = connectRepo(repo);
  await until(() => useStore.getState().tasksLoaded && userLoaded);
  unsubUser();
  const settings: Settings = {
    ...useStore.getState().settings,
    timezone: opts?.timezone ?? 'America/New_York',
  };
  useStore.setState({ today: opts?.today ?? '2026-11-19', settings });
  const h = { repo, disconnect, namespace };
  open.push(h);
  return h;
}

export function teardownAll(): void {
  for (const h of open.splice(0)) h.disconnect();
  clearUndo();
}

export function tasks(): Record<string, Task> {
  return useStore.getState().tasks;
}

export function task(id: string): Task {
  const t = useStore.getState().tasks[id];
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

export function toasts(): string[] {
  return useStore.getState().toasts.map((t) => t.message);
}

/** Titles of the untimed single-day cards on a date, in display order. */
export function dayTitles(date: ISODate, all: Record<string, Task> = tasks()): string[] {
  return Object.values(all)
    .filter((t) => !t.recurrence && t.date === date && !t.done && t.time === null && t.endDate === null)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1))
    .map((t) => t.title);
}

export function inboxTitles(all: Record<string, Task> = tasks()): string[] {
  return Object.values(all)
    .filter((t) => t.date === null && !t.done)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1))
    .map((t) => t.title);
}
