import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, Eye, EyeOff, LoaderCircle, MailCheck } from 'lucide-react';
import { authErrorMessage, resetPassword, signIn, signUp } from '@/data/auth';
import { DUR, EASE } from '@/lib/motion';
import { cx } from '@/lib/cx';
import { Icon } from '@/components/ui/Icon';
import styles from './AuthScreen.module.css';

type Mode = 'signin' | 'signup';
type View = 'form' | 'reset-sent';

const MIN_PASSWORD = 6;

/**
 * Sign-in screen (Firebase mode, signed out) in Notion's login style: app icon, "Tasks", a short
 * subtitle, Email + Password, a blue Continue button, Sign in ⇄ Create account, and
 * "Forgot password?" (reset email + confirmation). Enter submits; errors use authErrorMessage.
 */
export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const [view, setView] = useState<View>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<'submit' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const errorId = useId();
  const emailId = useId();
  const passwordId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const signup = mode === 'signup';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const addr = email.trim();
    if (!addr) {
      setError('Enter your email address.');
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setError('Enter your password.');
      passwordRef.current?.focus();
      return;
    }
    if (signup && password.length < MIN_PASSWORD) {
      setError(`Use a password with at least ${MIN_PASSWORD} characters.`);
      passwordRef.current?.focus();
      return;
    }
    setError(null);
    setBusy('submit');
    try {
      if (signup) await signUp(addr, password);
      else await signIn(addr, password);
      // Success: the auth listener swaps this screen out for the app.
    } catch (err) {
      if (mounted.current) setError(authErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const forgot = async () => {
    if (busy) return;
    const addr = email.trim();
    if (!addr) {
      setError('Enter your email address first, then tap “Forgot password?”.');
      emailRef.current?.focus();
      return;
    }
    setError(null);
    setBusy('reset');
    try {
      await resetPassword(addr);
      if (mounted.current) setView('reset-sent');
    } catch (err) {
      if (mounted.current) setError(authErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const switchMode = () => {
    setMode(signup ? 'signin' : 'signup');
    setError(null);
  };

  return (
    <main className={styles.screen}>
      <div className={styles.column}>
        <div className={styles.brand}>
          {iconFailed ? (
            <AppGlyph className={styles.icon} />
          ) : (
            <img
              className={styles.icon}
              src="/favicon.svg"
              alt=""
              width={56}
              height={56}
              draggable={false}
              onError={() => setIconFailed(true)}
            />
          )}
          <h1 className={styles.title}>Tasks</h1>
          <p className={styles.subtitle}>
            {view === 'reset-sent'
              ? 'Check your inbox'
              : signup
                ? 'Create an account to sync your tasks across devices.'
                : 'Sign in to sync your tasks across devices.'}
          </p>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {view === 'reset-sent' ? (
            <motion.div
              key="sent"
              className={styles.sent}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: DUR.base, ease: EASE }}
              role="status"
            >
              <Icon icon={MailCheck} size={20} className={styles.sentIcon} />
              <p>
                We sent a link to reset your password to <strong>{email.trim()}</strong>. Open it, choose a new password,
                then come back and sign in.
              </p>
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  setView('form');
                  setMode('signin');
                  setPassword('');
                  window.requestAnimationFrame(() => passwordRef.current?.focus());
                }}
              >
                Back to sign in
              </button>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              className={styles.form}
              onSubmit={submit}
              noValidate
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: DUR.base, ease: EASE }}
              aria-describedby={error ? errorId : undefined}
            >
              <label className={styles.label} htmlFor={emailId}>
                Email
              </label>
              <input
                ref={emailRef}
                id={emailId}
                className={styles.input}
                type="email"
                inputMode="email"
                name="email"
                autoComplete={signup ? 'email' : 'username'}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                placeholder="Enter your email address…"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={error !== null && !email.trim() ? true : undefined}
                data-testid="auth-email"
              />

              <label className={styles.label} htmlFor={passwordId}>
                Password
              </label>
              <div className={styles.passwordField}>
                <input
                  ref={passwordRef}
                  id={passwordId}
                  className={styles.input}
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  placeholder={signup ? 'Choose a password (6+ characters)' : 'Enter your password…'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="auth-password"
                />
                <button
                  type="button"
                  className={styles.reveal}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  <Icon icon={showPassword ? EyeOff : Eye} size={16} />
                </button>
              </div>

              <AnimatePresence initial={false}>
                {error && (
                  <motion.div
                    key="error"
                    id={errorId}
                    className={styles.errorWrap}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: DUR.base, ease: EASE }}
                    role="alert"
                    data-testid="auth-error"
                  >
                    <div className={styles.error}>
                      <Icon icon={CircleAlert} size={14} className={styles.errorIcon} />
                      <span>{error}</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <button
                type="submit"
                className={cx(styles.primary, busy === 'submit' && styles.loading)}
                disabled={busy !== null}
                aria-busy={busy === 'submit'}
                data-testid="auth-submit"
              >
                {busy === 'submit' ? <Icon icon={LoaderCircle} size={16} className={styles.spinner} /> : null}
                <span>{busy === 'submit' ? (signup ? 'Creating account…' : 'Signing in…') : 'Continue'}</span>
              </button>

              {!signup && (
                <button type="button" className={styles.link} onClick={forgot} disabled={busy !== null} data-testid="auth-forgot">
                  {busy === 'reset' ? 'Sending reset link…' : 'Forgot password?'}
                </button>
              )}
            </motion.form>
          )}
        </AnimatePresence>

        {view === 'form' && (
          <p className={styles.switch}>
            {signup ? 'Already have an account?' : 'New here?'}{' '}
            <button type="button" className={styles.switchBtn} onClick={switchMode} disabled={busy !== null} data-testid="auth-toggle">
              {signup ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        )}
      </div>
    </main>
  );
}

/** Fallback app mark: a Notion-style calendar page with a check. */
function AppGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 56 56" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="54" height="54" rx="12" fill="var(--bg-elevated)" stroke="var(--border-strong)" />
      <rect x="13" y="15" width="30" height="27" rx="4" fill="none" stroke="var(--text)" strokeWidth="2.4" />
      <path d="M13 22.5h30" stroke="var(--text)" strokeWidth="2.4" />
      <path d="M20 12v6M36 12v6" stroke="var(--text)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="m21.5 32 4.5 4.5 8.5-8.5" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
