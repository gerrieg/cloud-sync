export interface AdminSession {
  readonly username: string;
}

export type LoginOutcome =
  | { readonly ok: true; readonly username: string }
  | {
      readonly ok: false;
      readonly locked: true;
      readonly message: string;
      readonly retryAfterSeconds: number;
      readonly lockedUntil?: number;
    }
  | { readonly ok: false; readonly locked: false; readonly message: string };

export async function getCurrentAdmin(): Promise<AdminSession | null> {
  const response = await fetch('/api/auth/me', {
    method: 'GET',
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to check session (${response.status})`);
  }

  const data = (await response.json()) as { username?: unknown };
  if (typeof data.username !== 'string') {
    return null;
  }

  return { username: data.username };
}

/** Whether the login must collect an authenticator code; assumes yes when the server cannot be asked. */
export async function getTotpRequired(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/config', { credentials: 'same-origin' });
    if (!response.ok) {
      return true;
    }
    const data = (await response.json()) as { totpRequired?: unknown };
    return data.totpRequired !== false;
  } catch {
    return true;
  }
}

export async function loginAdmin(params: {
  username: string;
  password: string;
  totpCode?: string;
}): Promise<LoginOutcome> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = (await response.json().catch(() => ({}))) as {
    username?: unknown;
    error?: unknown;
    retryAfterSeconds?: unknown;
    lockedUntil?: unknown;
  };

  if (response.ok && typeof data.username === 'string') {
    return { ok: true, username: data.username };
  }

  const message =
    typeof data.error === 'string' && data.error.length > 0
      ? data.error
      : 'Authentication failed';

  if (response.status === 429) {
    const retryAfterSeconds =
      typeof data.retryAfterSeconds === 'number' && data.retryAfterSeconds > 0
        ? data.retryAfterSeconds
        : 900;
    return {
      ok: false,
      locked: true,
      message,
      retryAfterSeconds,
      lockedUntil: typeof data.lockedUntil === 'number' ? data.lockedUntil : undefined,
    };
  }

  return { ok: false, locked: false, message };
}

export async function logoutAdmin(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  });
}
