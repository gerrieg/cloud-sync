import { useState, type FormEvent } from 'react';
import type { SyncDirection } from '../../shared/calendar.js';
import type { CalendarDiscovery, CalendarRuleCreate } from '../lib/calendar-api.js';
import { checkboxLabelClass, controlRowClass, secondaryButtonClass, selectClass } from '../lib/styles.js';
import { BidirectionalHint, DirectionSelect } from './DirectionSelect.js';
import { WindowSelect } from './WindowSelect.js';

interface AddCalendarRuleFormProps {
  discovery: CalendarDiscovery;
  busy: boolean;
  onAdd(rule: CalendarRuleCreate): void;
}

export function AddCalendarRuleForm({ discovery, busy, onAdd }: AddCalendarRuleFormProps) {
  const writableGoogle = discovery.google.filter((calendar) => calendar.writable);
  const [appleUrl, setAppleUrl] = useState(discovery.apple[0]?.url ?? '');
  const [googleId, setGoogleId] = useState(writableGoogle[0]?.id ?? '');
  const [direction, setDirection] = useState<SyncDirection>('one_way');
  const [syncWindowDays, setSyncWindowDays] = useState<number | null>(30);
  const [syncReminders, setSyncReminders] = useState(false);

  const apple = discovery.apple.find((calendar) => calendar.url === appleUrl);
  const readOnly = apple?.readOnly ?? false;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!apple || !googleId) {
      return;
    }
    onAdd({
      appleCalendarUrl: apple.url,
      googleCalendarId: googleId,
      direction: readOnly ? 'one_way' : direction,
      syncWindowDays,
      syncReminders,
    });
  }

  if (discovery.apple.length === 0 || writableGoogle.length === 0) {
    return <p className="mt-4 text-sm text-slate-600">No Apple or writable Google calendars found.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className={`mt-4 ${controlRowClass}`}>
      <label className="text-sm text-slate-700">
        Apple calendar
        <select
          value={appleUrl}
          onChange={(event) => setAppleUrl(event.target.value)}
          className={selectClass}
        >
          {discovery.apple.map((calendar) => (
            <option key={calendar.url} value={calendar.url}>
              {calendar.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-slate-700">
        Google calendar
        <select
          value={googleId}
          onChange={(event) => setGoogleId(event.target.value)}
          className={selectClass}
        >
          {writableGoogle.map((calendar) => (
            <option key={calendar.id} value={calendar.id}>
              {calendar.name}
            </option>
          ))}
        </select>
      </label>
      <DirectionSelect value={direction} readOnlyCalendar={readOnly} onChange={setDirection} />
      <WindowSelect value={syncWindowDays} allLabel="All history (since 1990)" onChange={setSyncWindowDays} />
      <label className={checkboxLabelClass}>
        <input
          type="checkbox"
          checked={syncReminders}
          onChange={(event) => setSyncReminders(event.target.checked)}
        />
        Sync reminders
      </label>
      <button type="submit" disabled={busy} className={secondaryButtonClass}>
        Add rule
      </button>
      {!readOnly && (
        <div className="basis-full empty:hidden">
          <BidirectionalHint direction={direction} />
        </div>
      )}
      {readOnly && (
        <p className="basis-full text-xs text-slate-500">
          Read-only calendars sync one-way (Apple → Google).
        </p>
      )}
    </form>
  );
}
