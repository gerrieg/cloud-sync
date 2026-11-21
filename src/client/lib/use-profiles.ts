import { useEffect, useState } from 'react';
import { createProfile, listProfiles, type Profile } from './profiles-api.js';

/** Loads the Profiles and tracks which one is selected in the Profile Switcher. */
export function useProfiles(preferredId: string | null) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listProfiles()
      .then((loaded) => {
        if (!active) {
          return;
        }
        setProfiles(loaded);
        setSelectedId(loaded.find((p) => p.id === preferredId)?.id ?? loaded[0]?.id ?? null);
      })
      .catch((cause: unknown) => {
        if (active) {
          setLoadError(cause instanceof Error ? cause.message : 'Could not load Profiles');
        }
      });
    return () => {
      active = false;
    };
  }, [preferredId]);

  async function create(name: string) {
    const created = await createProfile(name);
    setProfiles((current) => [...(current ?? []), created]);
    setSelectedId(created.id);
  }

  function replace(updated: Profile) {
    setProfiles((current) => (current ?? []).map((p) => (p.id === updated.id ? updated : p)));
  }

  function remove(id: string) {
    const remaining = (profiles ?? []).filter((p) => p.id !== id);
    setProfiles(remaining);
    setSelectedId(remaining[0]?.id ?? null);
  }

  return {
    profiles,
    selected: profiles?.find((p) => p.id === selectedId) ?? null,
    selectedId,
    select: setSelectedId,
    loadError,
    create,
    replace,
    remove,
  };
}
