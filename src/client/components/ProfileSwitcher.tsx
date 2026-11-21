import { useState, type FormEvent } from 'react';
import type { Profile } from '../lib/profiles-api.js';

interface ProfileSwitcherProps {
  profiles: readonly Profile[];
  selectedId: string | null;
  onSelect(id: string): void;
  onCreate(name: string): Promise<void>;
}

export function ProfileSwitcher({ profiles, selectedId, onSelect, onCreate }: ProfileSwitcherProps) {
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await onCreate(name);
      setNewName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create Profile');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {profiles.length > 0 && (
        <select
          aria-label="Profile"
          value={selectedId ?? ''}
          onChange={(event) => onSelect(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800"
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
          className="w-36 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={creating || !newName.trim()}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
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
