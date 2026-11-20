import { useEffect, useId, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown, Share, X } from 'lucide-react';
import type { ThemePref } from '@shared/types';
import { formatTime } from '@shared/format';
import { useStore } from '@/store/store';
import { setSettingsOpen, setTheme, showToast, updateSettings } from '@/store/actions';
import { authErrorMessage, signOutUser } from '@/data/auth';
import { disablePush, enablePush, pushConfigured, showLocalTestNotification, usePushState, type PushState } from '@/push';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { platform } from '@/lib/platform';
import { cx } from '@/lib/cx';
import { Modal } from '@/components/ui/Modal';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { Kbd } from '@/components/ui/Kbd';
import { Icon } from '@/components/ui/Icon';
import { TimeInput } from '@/components/pickers/TimeInput';
import { waitForTaskSync } from './waitForTaskSync';
import styles from './SettingsModal.module.css';

/** Notion-style settings (560px modal; full-height sheet on phones). Opened via store.ui.settingsOpen. */
export function SettingsModal() {
  const open = useStore((s) => s.ui.settingsOpen);
  const phone = useLayoutMode() === 'phone';
  const titleId = useId();
  const close = () => setSettingsOpen(false);
  return (
    <>
      <Modal open={open && !phone} onClose={close} width={560} labelledBy={titleId} data-testid="settings-modal">
        <SettingsBody titleId={titleId} onClose={close} phone={false} />
      </Modal>
      <Sheet open={open && phone} onClose={close} snap="full" labelledBy={titleId} data-testid="settings-modal">
        <SettingsBody titleId={titleId} onClose={close} phone />
      </Sheet>
    </>
  );
}

function SettingsBody({ titleId, onClose, phone }: { titleId: string; onClose: () => void; phone: boolean }) {
  const theme = useStore((s) => s.theme);
  const weekStart = useStore((s) => s.settings.weekStart);
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)');

  return (
    <div className={cx(styles.root, phone && styles.phone)}>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          Settings
        </h2>
        <IconButton label="Close" hint="Esc" icon={X} onClick={onClose} data-testid="settings-close" />
      </header>

      <div className={styles.content}>
        <Section title="Appearance">
          <Row title="Theme" description="How Tasks looks on this device.">
            <Select
              value={theme}
              aria-label="Theme"
              data-testid="theme-select"
              onChange={(e) => setTheme(e.target.value as ThemePref)}
              options={[
                ['system', 'System'],
                ['light', 'Light'],
                ['dark', 'Dark'],
              ]}
            />
          </Row>
        </Section>

        <Section title="Calendar">
          <Row title="Start week on" description="First day of the week in the calendar and date pickers.">
            <Select
              value={String(weekStart)}
              aria-label="Start week on"
              data-testid="weekstart-select"
              onChange={(e) => updateSettings({ weekStart: e.target.value === '0' ? 0 : 1 })}
              options={[
                ['1', 'Monday'],
                ['0', 'Sunday'],
              ]}
            />
          </Row>
        </Section>

        <Section title="Notifications">
          <NotificationsSection />
        </Section>

        <Section title="Account">
          <AccountSection />
        </Section>

        {!phone && finePointer && (
          <Section title="Keyboard shortcuts">
            <Shortcuts />
          </Section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({
  title,
  description,
  children,
  muted,
  wrap,
  'data-testid': testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  muted?: boolean;
  /** Let the controls drop below the text when they don't fit beside it (long copy, two buttons). */
  wrap?: boolean;
  'data-testid'?: string;
}) {
  return (
    <div className={cx(styles.row, muted && styles.muted, wrap && styles.wrap)} data-testid={testId}>
      <div className={styles.rowText}>
        <div className={styles.rowTitle}>{title}</div>
        {description != null && <div className={styles.rowDesc}>{description}</div>}
      </div>
      {children != null && <div className={styles.control}>{children}</div>}
    </div>
  );
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: Array<[value: string, label: string]>;
  'data-testid'?: string;
}

/** Notion dropdown look on a native <select> (native picker on iOS, selectOption-friendly). */
function Select({ options, className, ...rest }: SelectProps) {
  return (
    <div className={styles.selectWrap}>
      <select className={cx(styles.select, className)} {...rest}>
        {options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <Icon icon={ChevronDown} size={12} className={styles.selectChevron} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

function deviceCopy(state: PushState, localMode: boolean): { title: string; description: ReactNode } {
  switch (state) {
    case 'subscribed':
      return { title: 'On for this device', description: 'Reminders and your morning summary arrive here.' };
    case 'default':
      return { title: 'Off on this device', description: 'Get reminders and your morning summary on this device.' };
    case 'error':
      return {
        title: 'Couldn’t turn on notifications',
        description: 'Something went wrong while subscribing. Check your connection and try again.',
      };
    case 'denied':
      return {
        title: 'Notifications are blocked',
        description: platform.isIOS
          ? 'Open the iPhone Settings app → Notifications → Tasks, and turn on Allow Notifications.'
          : 'Allow notifications for this site in your browser’s site settings, then come back here.',
      };
    case 'needs-install':
      return {
        title: 'Add Tasks to your Home Screen',
        description: (
          <>
            On iPhone, notifications only work in the installed app. In Safari tap{' '}
            <Icon icon={Share} size={13} className={styles.inlineIcon} aria-label="Share" /> Share, then{' '}
            <strong>Add to Home Screen</strong>, and open Tasks from your Home Screen.
          </>
        ),
      };
    case 'unsupported':
    default:
      if (!pushConfigured) {
        return {
          title: 'Not available',
          description: localMode
            ? 'Push notifications need sync — this copy of Tasks runs in local mode.'
            : 'Push notifications aren’t set up for this build.',
        };
      }
      return { title: 'Not supported', description: 'This browser can’t receive push notifications.' };
  }
}

function NotificationsSection() {
  const state = usePushState();
  const summary = useStore((s) => s.settings.summary);
  const localMode = useStore((s) => s.mode === 'local');
  const [busy, setBusy] = useState<'enable' | 'disable' | 'test' | null>(null);
  const copy = deviceCopy(state, localMode);
  const hasNotificationApi = typeof window !== 'undefined' && 'Notification' in window;
  const canTest = hasNotificationApi && state !== 'needs-install' && state !== 'denied';

  const enable = () => {
    if (busy) return;
    setBusy('enable');
    // Called synchronously from the click: the permission prompt needs the user gesture.
    enablePush()
      .then((next) => {
        if (next === 'subscribed') showToast('Notifications are on for this device');
      })
      .catch(() => showToast('Couldn’t turn on notifications'))
      .finally(() => setBusy(null));
  };

  const disable = () => {
    if (busy) return;
    setBusy('disable');
    disablePush()
      .then(() => showToast('Notifications are off for this device'))
      .catch(() => undefined)
      .finally(() => setBusy(null));
  };

  const test = () => {
    if (busy) return;
    setBusy('test');
    showLocalTestNotification()
      .then((ok) => showToast(ok ? 'Test notification sent' : 'Couldn’t show a notification on this device'))
      .catch(() => showToast('Couldn’t show a notification on this device'))
      .finally(() => setBusy(null));
  };

  let cta: ReactNode = null;
  if (state === 'default' || state === 'error') {
    cta = (
      <Button variant="primary" onClick={enable} disabled={busy !== null} data-testid="push-enable">
        {busy === 'enable' ? 'Enabling…' : state === 'error' ? 'Try again' : 'Enable'}
      </Button>
    );
  } else if (state === 'subscribed') {
    cta = (
      <Button variant="secondary" onClick={disable} disabled={busy !== null} data-testid="push-disable">
        {busy === 'disable' ? 'Turning off…' : 'Turn off'}
      </Button>
    );
  }

  const setSummary = (patch: Partial<typeof summary>) => updateSettings({ summary: { ...summary, ...patch } });

  return (
    <>
      <Row title={copy.title} description={copy.description} data-testid="push-status">
        {cta}
      </Row>
      {canTest && (
        <Row title="Test notification" description="Check that alerts show up on this device.">
          <Button variant="secondary" onClick={test} disabled={busy !== null} data-testid="push-test">
            {busy === 'test' ? 'Sending…' : 'Send test'}
          </Button>
        </Row>
      )}
      <Row
        title="Morning summary"
        description={`A notification at ${formatTime(summary.time)} with today’s tasks and anything overdue. Applies to all your devices.`}
      >
        <Toggle
          checked={summary.enabled}
          onChange={(v) => setSummary({ enabled: v })}
          aria-label="Morning summary"
          data-testid="summary-toggle"
        />
      </Row>
      <Row title="Summary time" muted={!summary.enabled}>
        <TimeInput
          value={summary.time}
          onChange={(t) => setSummary({ time: t })}
          disabled={!summary.enabled}
          aria-label="Summary time"
          className={styles.timeField}
          data-testid="summary-time"
        />
      </Row>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------------

/** Longest the sign-out waits for this device's push subscription to be removed (offline: give up). */
const UNSUBSCRIBE_WAIT_MS = 3000;
/** Longest the sign-out waits for this device's queued task changes to reach the server. */
const SYNC_WAIT_MS = 5000;

type SignOutPhase = 'idle' | 'syncing' | 'confirm' | 'signing-out';

function AccountSection() {
  const mode = useStore((s) => s.mode);
  const email = useStore((s) => s.user?.email ?? null);
  const online = useStore((s) => s.sync.online);
  const pushState = usePushState();
  const [phase, setPhase] = useState<SignOutPhase>('idle');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (mode === 'local') {
    return (
      <Row
        title="Local mode — not syncing"
        description="Tasks are saved in this browser only. Add your Firebase settings to the build to sign in and sync across devices."
        data-testid="account-local"
      />
    );
  }

  const proceed = () => {
    setPhase('signing-out');
    // Stop this device's reminders for the account first: after sign-out its device doc can no longer
    // be deleted (no auth), so it would keep receiving this account's notifications. Signing in here
    // again turns them back on by itself (resumeOnSignIn), so reminders never silently stay off.
    const unsubscribe =
      pushState === 'subscribed'
        ? Promise.race([
            disablePush({ resumeOnSignIn: true }).catch(() => undefined),
            new Promise<void>((resolve) => window.setTimeout(resolve, UNSUBSCRIBE_WAIT_MS)),
          ])
        : Promise.resolve();
    unsubscribe
      .then(() => signOutUser())
      .catch((e: unknown) => showToast(authErrorMessage(e)))
      .finally(() => {
        if (mounted.current) setPhase('idle');
      });
  };

  // Firestore keeps unsent changes per account: after sign-out they only upload when this account
  // signs in on this device again. So give them a moment to sync, and ask before leaving them behind.
  const signOut = () => {
    if (phase !== 'idle') return;
    setPhase('syncing');
    void waitForTaskSync(SYNC_WAIT_MS).then((synced) => {
      if (synced) proceed();
      else if (mounted.current) setPhase('confirm');
    });
  };

  if (phase === 'confirm') {
    return (
      <Row
        title="Some changes haven’t synced yet"
        description={`${online ? '' : 'You’re offline. '}If you sign out now, they’ll wait on this device and upload the next time you sign in here.`}
        wrap
        data-testid="sign-out-pending"
      >
        <div className={styles.buttons}>
          <Button variant="secondary" onClick={() => setPhase('idle')} data-testid="sign-out-cancel">
            Cancel
          </Button>
          <Button variant="danger" onClick={proceed} data-testid="sign-out-confirm">
            Sign out anyway
          </Button>
        </div>
      </Row>
    );
  }

  return (
    <Row title={email ?? 'Signed in'} description="Signed in · your tasks sync across your devices." data-testid="account-email">
      <Button variant="secondary" onClick={signOut} disabled={phase !== 'idle'} data-testid="sign-out">
        {phase === 'syncing' ? 'Syncing…' : phase === 'signing-out' ? 'Signing out…' : 'Sign out'}
      </Button>
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------------------------

const SHORTCUTS: Array<[label: string, keys: ReactNode]> = [
  ['Go to today', <Kbd key="t">T</Kbd>],
  ['Previous / next', [<Kbd key="l">←</Kbd>, <Kbd key="r">→</Kbd>]],
  ['Month view', <Kbd key="m">M</Kbd>],
  ['Week view', <Kbd key="w">W</Kbd>],
  ['New task in Inbox', <Kbd key="n">N</Kbd>],
  ['Show / hide Tasks list', <Kbd key="[">[</Kbd>],
  ['Show / hide Inbox', <Kbd key="]">]</Kbd>],
  ['Undo', <Kbd key="z" combo="mod+z" />],
  ['Redo', <Kbd key="sz" combo="mod+shift+z" />],
  ['Close', <Kbd key="esc">Esc</Kbd>],
];

function Shortcuts() {
  return (
    <dl className={styles.shortcuts}>
      {SHORTCUTS.map(([label, keys]) => (
        <div key={label} className={styles.shortcut}>
          <dt>{label}</dt>
          <dd className={styles.keys}>{keys}</dd>
        </div>
      ))}
    </dl>
  );
}
