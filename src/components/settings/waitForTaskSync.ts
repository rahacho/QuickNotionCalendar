import { useStore } from '@/store/store';

/**
 * Resolves true once every task change made on this device has been acknowledged by the server
 * (store.sync.pendingWrites, from the task snapshots' metadata), false when that doesn't happen
 * within `ms` or the device is offline (waiting can't help then).
 */
export function waitForTaskSync(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const verdict = (s = useStore.getState()): boolean | null => (!s.sync.pendingWrites ? true : !s.sync.online ? false : null);
    const now = verdict();
    if (now !== null) {
      resolve(now);
      return;
    }
    let timer = 0;
    const finish = (v: boolean): void => {
      unsubscribe();
      window.clearTimeout(timer);
      resolve(v);
    };
    const unsubscribe = useStore.subscribe((s) => {
      const v = verdict(s);
      if (v !== null) finish(v);
    });
    timer = window.setTimeout(() => finish(!useStore.getState().sync.pendingWrites), ms);
  });
}
