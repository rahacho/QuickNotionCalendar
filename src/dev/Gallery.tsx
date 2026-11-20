/**
 * Dev-only component gallery: http://localhost:5174/?gallery&section=<primitives|cards|menu|modal|sheet|toasts|shell>
 *   &theme=light|dark   &mode=desktop|tablet|phone (shell)   &left=0 &right=0 &drawer=1 (shell)
 * Imported dynamically by main.tsx only in DEV. Uses mock data — no store.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { MotionConfig } from 'motion/react';
import {
  Bell,
  Calendar,
  CalendarDays,
  ChevronDown,
  Copy,
  Ellipsis,
  Inbox,
  Plus,
  Repeat,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { ToastItem } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { Toggle } from '@/components/ui/Toggle';
import { TextInput } from '@/components/ui/TextInput';
import { Kbd } from '@/components/ui/Kbd';
import { Tooltip } from '@/components/ui/Tooltip';
import { Popover } from '@/components/ui/Popover';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { Sheet } from '@/components/ui/Sheet';
import { ToastStack } from '@/components/ui/Toast';
import { Icon } from '@/components/ui/Icon';
import { TaskCard } from '@/components/card/TaskCard';
import { AppShellView } from '@/components/layout/AppShellView';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import type { LayoutMode } from '@/store/store';
import { cx } from '@/lib/cx';
import { mockOcc } from './mock';
import { MockCalendar, MockInbox, MockInboxSheet, MockTasksSidebar } from './MockPanels';
import styles from './Gallery.module.css';

const params = new URLSearchParams(window.location.search);
const section = params.get('section') ?? 'primitives';

export function Gallery() {
  useLayoutEffect(() => {
    const t = params.get('theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  }, []);
  return (
    <MotionConfig reducedMotion="user">
      {section === 'shell' ? (
        <ShellSection />
      ) : section === 'calendar' ? (
        <div className={styles.shellFrame}>
          <MockCalendar />
        </div>
      ) : (
        <div className={styles.page}>
          <nav className={styles.nav}>
            {['primitives', 'cards', 'menu', 'modal', 'sheet', 'toasts', 'shell'].map((s) => (
              <a key={s} href={`?gallery&section=${s}`} className={cx(styles.navLink, s === section && styles.navActive)}>
                {s}
              </a>
            ))}
            <ThemeSwitch />
          </nav>
          {section === 'primitives' && <PrimitivesSection />}
          {section === 'cards' && <CardsSection />}
          {section === 'menu' && <MenuSection />}
          {section === 'modal' && <ModalSection />}
          {section === 'sheet' && <SheetSection />}
          {section === 'toasts' && <ToastSection />}
        </div>
      )}
    </MotionConfig>
  );
}

function ThemeSwitch() {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark');
  return (
    <label className={styles.themeSwitch}>
      <span>Dark</span>
      <Toggle
        checked={dark}
        aria-label="Dark theme"
        onChange={(v) => {
          setDark(v);
          document.documentElement.setAttribute('data-theme', v ? 'dark' : 'light');
        }}
      />
    </label>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.row2}>
      <div className={styles.rowLabel}>{label}</div>
      <div className={styles.rowBody}>{children}</div>
    </div>
  );
}

function PrimitivesSection() {
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(true);
  const [c3, setC3] = useState(false);
  const [t1, setT1] = useState(false);
  const [t2, setT2] = useState(true);
  return (
    <section className={styles.section}>
      <h2 className={styles.h2}>Primitives</h2>
      <Row label="Button ghost">
        <Button>Today</Button>
        <Button iconRight={ChevronDown}>Month</Button>
        <Button icon={Inbox}>Move to Inbox</Button>
        <Button active>Active</Button>
        <Button disabled>Disabled</Button>
      </Row>
      <Row label="Button variants">
        <Button variant="primary" size="md">
          Sign in
        </Button>
        <Button variant="secondary" size="md">
          Cancel
        </Button>
        <Button variant="danger" icon={Trash2}>
          Delete
        </Button>
        <Button variant="primary" icon={Plus}>
          New
        </Button>
      </Row>
      <Row label="IconButton">
        <IconButton label="Search" icon={Search} />
        <IconButton label="More" icon={Ellipsis} size={24} />
        <IconButton label="Close" icon={X} />
        <IconButton label="Inbox" icon={Inbox} dot />
        <IconButton label="Active" icon={CalendarDays} active />
      </Row>
      <Row label="Checkbox">
        <Checkbox checked={c1} onChange={setC1} aria-label="One" />
        <Checkbox checked={c2} onChange={setC2} aria-label="Two" />
        <Checkbox checked={c3} onChange={setC3} label="Done" />
        <Checkbox checked={false} onChange={() => {}} disabled aria-label="Disabled" />
        <Checkbox checked size={20} onChange={() => {}} aria-label="Big" />
      </Row>
      <Row label="Toggle">
        <Toggle checked={t1} onChange={setT1} aria-label="Off" />
        <Toggle checked={t2} onChange={setT2} aria-label="On" />
      </Row>
      <Row label="TextInput">
        <div style={{ width: 260 }}>
          <TextInput placeholder="Type a task, press Enter" />
        </div>
        <div style={{ width: 220 }}>
          <TextInput icon={Search} placeholder="Search" />
        </div>
        <div style={{ width: 200 }}>
          <TextInput defaultValue="3:00 PM" trailing={<Kbd>↵</Kbd>} />
        </div>
      </Row>
      <Row label="Kbd">
        <Kbd combo="mod+z" />
        <Kbd>[</Kbd>
        <Kbd combo="ArrowLeft" />
        <Kbd>T</Kbd>
      </Row>
      <Row label="Tooltip">
        <Tooltip content="Close sidebar" hint="[">
          <Button data-testid="tooltip-target">Hover me</Button>
        </Tooltip>
        <IconButton label="Undo" icon={Copy} hint="⌘Z" />
      </Row>
      <Row label="Icons">
        <Icon icon={Calendar} />
        <Icon icon={Repeat} />
        <Icon icon={Bell} />
        <Icon icon={Inbox} />
        <Icon icon={Trash2} />
      </Row>
    </section>
  );
}

function CardsSection() {
  const plain = mockOcc('Call mom');
  const timed = mockOcc('Dentist appointment', { time: '15:00' });
  const recurring = mockOcc('Gym', { recurring: true });
  const recurringTimed = mockOcc('Standup', { recurring: true, time: '09:30' });
  const overdue = mockOcc('Pay rent', { date: '2026-11-12' });
  const long = mockOcc('Finish quarterly report draft and send it to Sarah for review before Friday supercalifragilisticexpialidocious');
  const done = mockOcc('Pick up dry cleaning', { done: true });
  const bar = mockOcc('Trip to Boston', { date: '2026-11-23', endDate: '2026-11-25', time: '08:00' });
  const inbox = mockOcc('Research standing desks', { date: null });
  return (
    <section className={styles.section}>
      <h2 className={styles.h2}>TaskCard</h2>
      <div className={styles.cardGrid}>
        <div className={styles.cardCell}>
          <div className={styles.cellLabel}>calendar</div>
          <TaskCard occ={plain} variant="calendar" />
          <TaskCard occ={timed} variant="calendar" />
          <TaskCard occ={recurring} variant="calendar" />
          <TaskCard occ={recurringTimed} variant="calendar" />
          <TaskCard occ={overdue} variant="calendar" overdue />
          <TaskCard occ={long} variant="calendar" />
          <TaskCard occ={done} variant="calendar" />
        </div>
        <div className={cx(styles.cardCell, styles.cardCellNarrow)}>
          <div className={styles.cellLabel}>compact</div>
          <TaskCard occ={plain} variant="compact" />
          <TaskCard occ={timed} variant="compact" />
          <TaskCard occ={recurring} variant="compact" />
          <TaskCard occ={overdue} variant="compact" overdue />
          <TaskCard occ={long} variant="compact" />
        </div>
        <div className={styles.cardCell}>
          <div className={styles.cellLabel}>dragging (source ghost)</div>
          <TaskCard occ={timed} variant="calendar" dragging />
          <div className={styles.cellLabel}>overlay</div>
          <div style={{ width: 172, margin: '0 6px' }}>
            <TaskCard occ={timed} variant="overlay" />
          </div>
        </div>
        <div className={styles.cardCell} style={{ width: 300 }}>
          <div className={styles.cellLabel}>inbox</div>
          <TaskCard occ={inbox} variant="inbox" />
          <TaskCard occ={long} variant="inbox" />
        </div>
      </div>
      <div className={styles.cellLabel} style={{ marginTop: 24 }}>
        bar (continues before / after / both / none)
      </div>
      <div className={styles.barTrack}>
        <TaskCard occ={bar} variant="bar" style={{ position: 'absolute', top: 6, left: 0, right: '50%' }} />
        <TaskCard occ={bar} variant="bar" continuesAfter style={{ position: 'absolute', top: 6, left: '50%', right: 0 }} />
        <TaskCard occ={bar} variant="bar" continuesBefore style={{ position: 'absolute', top: 42, left: 0, right: '40%' }} />
        <TaskCard occ={bar} variant="bar" continuesBefore continuesAfter style={{ position: 'absolute', top: 78, left: 0, right: 0 }} />
        <TaskCard occ={overdue} variant="bar" overdue style={{ position: 'absolute', top: 114, left: '20%', right: '30%' }} />
      </div>
    </section>
  );
}

function MenuSection() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<'month' | 'week'>('month');
  return (
    <section className={styles.section}>
      <h2 className={styles.h2}>Popover + Menu</h2>
      <Button ref={anchor} iconRight={ChevronDown} active={open} onClick={() => setOpen((o) => !o)} data-testid="menu-anchor">
        Month
      </Button>
      <Popover open={open} onOpenChange={setOpen} anchor={anchor} placement="bottom-start" width={240}>
        <Menu>
          <MenuLabel>View</MenuLabel>
          <MenuItem icon={Calendar} label="Month" hint="M" selected={view === 'month'} onSelect={() => setView('month')} />
          <MenuItem icon={CalendarDays} label="Week" hint="W" selected={view === 'week'} onSelect={() => setView('week')} />
          <MenuSeparator />
          <MenuItem
            icon={Repeat}
            label="Repeat"
            data-testid="menu-submenu"
            submenu={
              <>
                <MenuItem label="Every day" onSelect={() => {}} />
                <MenuItem label="Every weekday" onSelect={() => {}} />
                <MenuItem label="Every week on Thursday" onSelect={() => {}} />
              </>
            }
          />
          <MenuItem icon={Copy} label="Duplicate" hint="⌘D" onSelect={() => {}} />
          <MenuItem icon={Trash2} label="Delete" danger onSelect={() => {}} />
        </Menu>
      </Popover>
    </section>
  );
}

function PeekMock({ titleId }: { titleId: string }) {
  const [done, setDone] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const [remind, setRemind] = useState('At time of task');
  const remindRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div className={styles.peekTop}>
        <IconButton label="More" icon={Ellipsis} tooltip={false} />
        <IconButton label="Close" icon={X} tooltip={false} />
      </div>
      <div className={styles.peekBody}>
        <h1 id={titleId} className={styles.peekTitle}>
          Finish quarterly report
        </h1>
        <div className={styles.prop}>
          <span className={styles.propLabel}>
            <Icon icon={Calendar} /> Date
          </span>
          <span className={styles.propValue}>November 19, 2026 3:00 PM</span>
        </div>
        <div className={styles.prop}>
          <span className={styles.propLabel}>
            <Icon icon={Repeat} /> Repeat
          </span>
          <span className={cx(styles.propValue, styles.empty)}>Empty</span>
        </div>
        <div className={styles.prop}>
          <span className={styles.propLabel}>
            <Icon icon={Bell} /> Remind
          </span>
          <button
            ref={remindRef}
            type="button"
            className={styles.propValue}
            data-testid="peek-remind"
            onClick={() => setRemindOpen((o) => !o)}
          >
            {remind}
          </button>
          <Popover open={remindOpen} onOpenChange={setRemindOpen} anchor={remindRef} width={220} data-testid="remind-menu">
            <Menu>
              {['None', 'At time of task', '10 minutes before', '1 hour before', '1 day before'].map((r) => (
                <MenuItem key={r} label={r} selected={r === remind} onSelect={() => setRemind(r)} />
              ))}
            </Menu>
          </Popover>
        </div>
        <div className={styles.prop}>
          <span className={styles.propLabel}>
            <Icon icon={CalendarDays} /> Done
          </span>
          <span className={styles.propValue}>
            <Checkbox checked={done} onChange={setDone} aria-label="Done" />
          </span>
        </div>
        <div className={styles.divider} />
        <div className={styles.actions}>
          <Button icon={Inbox}>Move to Inbox</Button>
          <Button icon={Trash2}>Delete</Button>
        </div>
      </div>
    </>
  );
}

function ModalSection() {
  const [open, setOpen] = useState(true);
  return (
    <section className={styles.section}>
      <h2 className={styles.h2}>Modal (center peek frame)</h2>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open modal
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} labelledBy="peek-title" data-testid="peek">
        <PeekMock titleId="peek-title" />
      </Modal>
    </section>
  );
}

function SheetSection() {
  const [open, setOpen] = useState(true);
  return (
    <section className={styles.section}>
      <h2 className={styles.h2}>Sheet (phone)</h2>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="sheet-open">
        Open sheet
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} labelledBy="sheet-title" data-testid="sheet">
        <div className={styles.sheetContent}>
          <div id="sheet-title" className={styles.sheetTitle}>
            New task · Thu, Nov 19
          </div>
          <TextInput placeholder="Task name" data-testid="sheet-input" />
          <div className={styles.sheetHint}>Press Enter to add. Swipe down to close.</div>
        </div>
      </Sheet>
    </section>
  );
}

function ToastSection() {
  const [toasts, setToasts] = useState<ToastItem[]>([
    { id: 't1', message: 'Moved 2 tasks to today', duration: 0 },
    { id: 't2', message: 'Task completed', action: { label: 'Undo', run: () => {} }, duration: 0 },
  ]);
  return (
    <section className={styles.section}>
      <h2 className={styles.h2}>Toasts</h2>
      <Button
        variant="secondary"
        onClick={() =>
          setToasts((t) => [...t, { id: String(Date.now()), message: 'Task deleted', action: { label: 'Undo', run: () => {} }, duration: 5000 }])
        }
      >
        Add toast (5s)
      </Button>
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </section>
  );
}

function ShellSection() {
  const detected = useLayoutMode();
  const forced = params.get('mode') as LayoutMode | null;
  const mode: LayoutMode = forced === 'desktop' || forced === 'tablet' || forced === 'phone' ? forced : detected;
  const [leftOpen, setLeftOpen] = useState(params.get('left') !== '0');
  const [rightOpen, setRightOpen] = useState(params.get('right') !== '0');
  const [drawerOpen, setDrawerOpen] = useState(params.get('drawer') === '1');
  return (
    <div className={styles.shellFrame}>
      <AppShellView
        contained
        mode={mode}
        left={<MockTasksSidebar />}
        center={<MockCalendar phone={mode === 'phone'} onMenu={() => setDrawerOpen(true)} overdueDot />}
        right={<MockInbox />}
        phoneSheet={<MockInboxSheet />}
        overlays={null}
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        drawerOpen={drawerOpen}
        onToggleLeft={() => setLeftOpen((v) => !v)}
        onToggleRight={() => setRightOpen((v) => !v)}
        onDrawerOpenChange={setDrawerOpen}
        overdueDot
      />
    </div>
  );
}
