import { useStore } from '@/store/store';
import { dismissToast } from '@/store/actions';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { ToastStack } from './Toast';

/** Renders store.toasts bottom-center (phone: above the collapsed Inbox sheet). */
export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  const mode = useLayoutMode();
  return <ToastStack toasts={toasts} onDismiss={dismissToast} position={mode === 'phone' ? 'phone' : 'default'} />;
}
