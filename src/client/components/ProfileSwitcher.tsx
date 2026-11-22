import { useState, type FormEvent } from 'react';
import { useAsyncAction } from '../lib/use-async-action.js';
import type { Profile } from '../lib/profiles-api.js';
import { primaryButtonClass } from '../lib/styles.js';

interface ProfileSwitcherProps {
  profiles: readonly Profile[];
  selectedId: string | null;
  onSelect(id: string): void;
  onCreate(name: string): Promise<void>;
}

export function ProfileSwitcher({ profiles, selectedId, onSelect, onCreate }: ProfileSwitcherProps) {
  const [newName, setNewName] = useState('');
  const { busy, error, run } = useAsyncAction();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      return;
    }
    void run(async () => {
      await onCreate(name);
      setNewName('');
    }, 'Could not create Profile');
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {profiles.length > 0 && (
        <select
          aria-label="Profile"
          value={selectedId ?? ''}
          onChange={(event) => onSelect(event.target.value)}
          className="h-9 max-w-48 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800"
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      )}
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          aria-label="New Profile name"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="New Profile"
          maxLength={100}
          className="h-9 w-36 rounded-lg border border-slate-300 bg-white px-3 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !newName.trim()}
          className={primaryButtonClass}
        >
          Add Profile
        </button>
      </form>
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </div>
  );
}
