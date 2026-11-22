/** JSON request against the app API; throws an Error carrying the server's message on failure. */
export async function apiRequest<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const data = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string' && data.error ? data.error : `Request failed (${response.status})`,
    );
  }
  return data as T;
}

export const profilePath = (profileId: string) => `/api/profiles/${encodeURIComponent(profileId)}`;
