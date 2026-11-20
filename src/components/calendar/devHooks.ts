/**
 * DEV ONLY (imported behind import.meta.env.DEV): a window hook so Playwright scripts and manual
 * testing can seed tasks and inspect state without going through the UI.
 *   window.__cal.seed()                    → a realistic month of tasks around today
 *   window.__cal.actions.createTask({...}) → any store action
 *   window.__cal.state()                   → the zustand state
 */
import type { ISODate } from '@shared/types';
import { addDays } from '@shared/dates';
import { useStore } from '@/store/store';
import * as actions from '@/store/actions';

function seed(today: ISODate = useStore.getState().today): string[] {
  const d = (n: number) => addDays(today, n);
  const ids: string[] = [];
  const add = (input: Parameters<typeof actions.createTask>[0]) => {
    const id = actions.createTask(input);
    if (id) ids.push(id);
    return id;
  };
  add({ title: 'Dentist appointment', date: d(-9), time: '15:00' });
  add({ title: 'Pay rent', date: d(-7) });
  add({ title: 'Renew passport photos', date: d(-7) });
  add({ title: 'Gym', date: d(-3), time: '18:00', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1, 4] } });
  add({ title: 'Finish quarterly report draft and send it to Sarah for review', date: today });
  add({ title: 'Call mom', date: today });
  add({ title: 'Grocery run', date: d(1) });
  add({ title: 'Water plants', date: d(2), recurrence: { freq: 'weekly', interval: 1 } });
  add({ title: 'Trip to Boston', date: d(4), endDate: d(6) });
  add({ title: 'Thanksgiving dinner prep', date: d(7), time: '10:30' });
  add({ title: 'Design conference', date: d(9), endDate: d(13) });
  add({ title: 'Book flights', date: d(12) });
  add({ title: 'Call the bank about the card' });
  add({ title: 'Pick a gift for Ana' });
  return ids;
}

declare global {
  interface Window {
    __cal?: {
      seed: typeof seed;
      actions: typeof actions;
      state: () => ReturnType<typeof useStore.getState>;
      store: typeof useStore;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__cal = { seed, actions, state: () => useStore.getState(), store: useStore };
}

export {};
