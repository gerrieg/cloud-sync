import { useEffect, useState, type FormEvent } from 'react';
import { controlRowClass, inputClass, secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import {
  testAppleConnection,
  updateProfile,
  type AppleTestReport,
  type Profile,
} from '../lib/profiles-api.js';

interface AppleConnectionProps {
  profile: Profile;
  onChange(profile: Profile): void;
}

const PROTOCOLS = [
  ['caldav', 'CalDAV'],
  ['carddav', 'CardDAV'],
  ['imap', 'IMAP'],
] as const;

export function AppleConnection({ profile, onChange }: AppleConnectionProps) {
  const [appleId, setAppleId] = useState('');
  const [password, setPassword] = useState('');
  const [report, setReport] = useState<AppleTestReport | null>(null);
  const { busy, error, run, reset } = useAsyncAction();

  useEffect(() => {
    setAppleId('');
    setPassword('');
    setReport(null);
    reset();
  }, [profile.id, reset]);

  function handleSave(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const updated = await updateProfile(profile.id, {
        appleId: appleId.trim(),
        appleAppPassword: password,
      });
      setPassword('');
      setAppleId('');
      setReport(null);
      onChange(updated);
    });
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h2 className="text-lg font-semibold text-slate-900">Apple iCloud</h2>
      <p className="mt-1 text-sm text-slate-600">
        {profile.appleConnected
          ? `Connected as ${profile.appleId}`
          : 'Not connected. Use an app-specific password from appleid.apple.com.'}
      </p>

      <form onSubmit={handleSave} className={`mt-4 ${controlRowClass}`}>
        <label className="text-sm text-slate-700">
          Apple ID
          <input
            type="email"
            value={appleId}
            onChange={(event) => setAppleId(event.target.value)}
            autoComplete="off"
            className={inputClass}
          />
        </label>
        <label className="text-sm text-slate-700">
          App-specific password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder={profile.appleConnected ? '•••• stored encrypted' : ''}
            className={inputClass}
          />
        </label>
        <button
          type="submit"
          disabled={busy || !appleId.trim() || !password}
          className={secondaryButtonClass}
        >
          Save Apple credentials
        </button>
        <button
          type="button"
          disabled={busy || !profile.appleConnected}
          className={secondaryButtonClass}
          onClick={() => void run(async () => setReport(await testAppleConnection(profile.id)))}
        >
          Test connection
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}

      {report && (
        <ul aria-label="Connection results" className="mt-4 space-y-1 text-sm">
          {PROTOCOLS.map(([key, label]) => {
            const result = report[key];
            return (
              <li key={key} className={result.ok ? 'text-green-700' : 'text-red-700'}>
                {label}: {result.ok ? 'Passed' : `Failed – ${result.error}`}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
