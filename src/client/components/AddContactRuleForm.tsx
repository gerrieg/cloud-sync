import { useState, type FormEvent } from 'react';
import type { SyncDirection } from '../../shared/calendar.js';
import type { ContactGroupDiscovery, ContactRuleCreate } from '../lib/contacts-api.js';
import { controlRowClass, secondaryButtonClass, selectClass } from '../lib/styles.js';
import { BidirectionalHint, DirectionSelect } from './DirectionSelect.js';

interface AddContactRuleFormProps {
  discovery: ContactGroupDiscovery;
  busy: boolean;
  onAdd(rule: ContactRuleCreate): void;
}

export function AddContactRuleForm({ discovery, busy, onAdd }: AddContactRuleFormProps) {
  const [appleUid, setAppleUid] = useState(discovery.apple[0]?.uid ?? '');
  const [googleName, setGoogleName] = useState(discovery.google[0]?.resourceName ?? '');
  const [direction, setDirection] = useState<SyncDirection>('one_way');

  if (discovery.google.length === 0) {
    return (
      <p className="mt-4 text-sm text-slate-600">
        No Google labels found. Create a label in Google Contacts first, then reload this page.
      </p>
    );
  }
  if (discovery.apple.length === 0) {
    return <p className="mt-4 text-sm text-slate-600">No Apple contact groups found.</p>;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (appleUid && googleName) {
      onAdd({ appleGroupUid: appleUid, googleGroupResourceName: googleName, direction });
    }
  }

  return (
    <form onSubmit={handleSubmit} className={`mt-4 ${controlRowClass}`}>
      <label className="text-sm text-slate-700">
        Apple group
        <select
          value={appleUid}
          onChange={(event) => setAppleUid(event.target.value)}
          className={selectClass}
        >
          {discovery.apple.map((group) => (
            <option key={group.uid} value={group.uid}>
              {group.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-slate-700">
        Google label
        <select
          value={googleName}
          onChange={(event) => setGoogleName(event.target.value)}
          className={selectClass}
        >
          {discovery.google.map((group) => (
            <option key={group.resourceName} value={group.resourceName}>
              {group.name}
            </option>
          ))}
        </select>
      </label>
      <DirectionSelect value={direction} readOnlyCalendar={false} onChange={setDirection} />
      <button type="submit" disabled={busy} className={secondaryButtonClass}>
        Add contact rule
      </button>
      <div className="basis-full empty:hidden">
        <BidirectionalHint direction={direction} />
      </div>
    </form>
  );
}
