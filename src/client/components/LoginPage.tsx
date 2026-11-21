import { useState, type FormEvent } from 'react';
import { loginAdmin } from '../lib/api.js';

interface LoginPageProps {
  onSuccess(username: string): void;
}

function formatRetryDuration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 1) {
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} seconds`;
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; locked: boolean } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const outcome = await loginAdmin({
        username: username.trim(),
        password,
        totpCode: totpCode.trim(),
      });

      if (outcome.ok) {
        onSuccess(outcome.username);
        return;
      }

      if (outcome.locked) {
        setError({
          locked: true,
          message: `${outcome.message} Login is locked for ${formatRetryDuration(outcome.retryAfterSeconds)}.`,
        });
      } else {
        setError({
          locked: false,
          message: outcome.message,
        });
      }
    } catch {
      setError({
        locked: false,
        message: 'Unable to reach the server. Please try again.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <section className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <p className="text-xs font-semibold tracking-wider text-sky-600 uppercase">Cloud Sync</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-600">
            Enter your administrator credentials and 6-digit authenticator code.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
              error.locked
                ? 'border-amber-300 bg-amber-50 text-amber-900'
                : 'border-red-300 bg-red-50 text-red-900'
            }`}
          >
            {error.message}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-slate-700">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-xs focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-xs focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="totpCode" className="block text-sm font-medium text-slate-700">
              Authenticator code
            </label>
            <input
              id="totpCode"
              name="totpCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="\d{6}"
              placeholder="000000"
              required
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tracking-widest text-slate-900 shadow-xs focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white shadow-xs transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}
