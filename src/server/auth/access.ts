import { sanitizeNextPath } from '../../shared/redirect.js';

export { sanitizeNextPath };

export type RouteCategory = 'public' | 'self_authenticated' | 'session_protected';

export type AccessDecision =
  | { readonly category: RouteCategory; readonly action: 'allow' }
  | { readonly category: 'session_protected'; readonly action: 'unauthorized'; readonly status: 401 }
  | {
      readonly category: 'session_protected';
      readonly action: 'redirect';
      readonly status: 302;
      readonly location: string;
    };

export interface AccessInput {
  readonly pathname: string;
  readonly search: string;
  readonly isAuthenticated: boolean;
}

const PUBLIC_EXACT_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/health',
  '/favicon.ico',
  '/favicon.svg',
  '/robots.txt',
]);

const SELF_AUTHENTICATED_PREFIXES = ['/webhooks/google/', '/api/trigger-sync/'] as const;

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

function hasUnsafePathSequence(pathname: string): boolean {
  if (pathname.includes('\\') || CONTROL_CHAR_PATTERN.test(pathname)) {
    return true;
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  if (decoded.includes('\\') || CONTROL_CHAR_PATTERN.test(decoded)) {
    return true;
  }
  return decoded.split('/').some((segment) => segment === '..' || segment === '.');
}

export function classifyRoute(pathname: string): RouteCategory {
  if (hasUnsafePathSequence(pathname)) {
    return 'session_protected';
  }

  if (PUBLIC_EXACT_PATHS.has(pathname)) {
    return 'public';
  }

  if (pathname.startsWith('/assets/') && pathname.length > '/assets/'.length) {
    return 'public';
  }

  for (const prefix of SELF_AUTHENTICATED_PREFIXES) {
    if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
      return 'self_authenticated';
    }
  }

  return 'session_protected';
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export function decideAccess(input: AccessInput): AccessDecision {
  const category = classifyRoute(input.pathname);

  if (category === 'public' || category === 'self_authenticated') {
    return { category, action: 'allow' };
  }

  if (input.isAuthenticated) {
    return { category: 'session_protected', action: 'allow' };
  }

  if (isApiPath(input.pathname)) {
    return { category: 'session_protected', action: 'unauthorized', status: 401 };
  }

  const safeNext = sanitizeNextPath(`${input.pathname}${input.search}`);
  const location = safeNext === '/' ? '/login' : `/login?next=${encodeURIComponent(safeNext)}`;

  return {
    category: 'session_protected',
    action: 'redirect',
    status: 302,
    location,
  };
}
