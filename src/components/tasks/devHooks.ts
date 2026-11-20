/**
 * Development-only window hook for manual testing and Playwright scripts (seeding past-dated tasks,
 * reading state). The whole body is dropped from production builds (import.meta.env.DEV is false there).
 *
 *   window.__tasksDev.actions.createTask({ title: 'Pay rent', date: '2026-11-12' })
 *   window.__tasksDev.state().tasks
 *   window.__tasksDev.setState({ sync: { ...window.__tasksDev.state().sync, error: 'Permission denied' } })
 */
import * as actions from '@/store/actions';
import { useStore } from '@/store/store';

declare global {
  interface Window {
    __tasksDev?: {
      actions: typeof actions;
      state: () => ReturnType<typeof useStore.getState>;
      setState: typeof useStore.setState;
    };
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__tasksDev = { actions, state: () => useStore.getState(), setState: useStore.setState };
}

export {};
