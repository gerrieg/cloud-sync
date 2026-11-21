const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const ENCODED_CONTROL_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

export function sanitizeNextPath(candidate: string | null | undefined): string {
  if (!candidate || typeof candidate !== 'string') {
    return '/';
  }

  if (
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    CONTROL_CHAR_PATTERN.test(candidate) ||
    ENCODED_CONTROL_PATTERN.test(candidate)
  ) {
    return '/';
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate, 'http://localhost');
  } catch {
    return '/';
  }

  if (parsed.origin !== 'http://localhost') {
    return '/';
  }

  if (parsed.pathname === '/login' || parsed.pathname.startsWith('/login/')) {
    return '/';
  }

  return `${parsed.pathname}${parsed.search}`;
}
