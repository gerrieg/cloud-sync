import { describe, expect, it } from 'vitest';
import {
  classifyRoute,
  decideAccess,
  sanitizeNextPath,
} from '../../src/server/auth/access.js';

describe('classifyRoute', () => {
  it.each([
    '/login',
    '/api/auth/login',
    '/api/health',
    '/assets/index-abc123.js',
    '/assets/style.css',
    '/favicon.ico',
    '/favicon.svg',
    '/robots.txt',
  ])('classifies %s as public', (pathname) => {
    expect(classifyRoute(pathname)).toBe('public');
  });

  it.each([
    '/webhooks/google/profile-1',
    '/webhooks/google/abc/extra',
    '/api/trigger-sync/profile-1',
    '/api/trigger-sync/abc-123',
  ])('classifies %s as self_authenticated', (pathname) => {
    expect(classifyRoute(pathname)).toBe('self_authenticated');
  });

  it.each([
    '/',
    '/profiles',
    '/profiles/123',
    '/api/auth/me',
    '/api/auth/logout',
    '/api/profiles',
    '/api/profiles/p1/test-apple',
    '/api/auth/google/callback',
    '/api/health/extra',
    '/api/auth/login/extra',
    '/webhooks/google',
    '/webhooks/google/',
    '/api/trigger-sync',
    '/api/trigger-sync/',
    '/webhooks/other/123',
    '/assets/../api/auth/me',
    '/assets/%2e%2e/api/auth/me',
    '/login/extra',
  ])('classifies %s as session_protected', (pathname) => {
    expect(classifyRoute(pathname)).toBe('session_protected');
  });
});

describe('sanitizeNextPath', () => {
  it('preserves safe relative app paths with query strings', () => {
    expect(sanitizeNextPath('/profiles/123')).toBe('/profiles/123');
    expect(sanitizeNextPath('/profiles/123?tab=calendars')).toBe('/profiles/123?tab=calendars');
    expect(sanitizeNextPath('/')).toBe('/');
  });

  it.each([
    undefined,
    null,
    '',
    'https://evil.com',
    'http://evil.com/phish',
    '//evil.com',
    '//evil.com/path',
    '///evil.com',
    '/\\evil.com',
    '/foo\\bar',
    'javascript:alert(1)',
    'relative/path',
    '/login',
    '/login?next=/profiles',
    '/%0d%0aSet-Cookie:evil=1',
    '/path\r\nHeader: inject',
  ])('blocks unsafe or looping redirect target %j and falls back to "/"', (target) => {
    expect(sanitizeNextPath(target)).toBe('/');
  });
});

describe('decideAccess', () => {
  it('allows public and self-authenticated routes without a session', () => {
    expect(decideAccess({ pathname: '/api/health', search: '', isAuthenticated: false })).toEqual({
      category: 'public',
      action: 'allow',
    });
    expect(decideAccess({ pathname: '/login', search: '', isAuthenticated: false })).toEqual({
      category: 'public',
      action: 'allow',
    });
    expect(
      decideAccess({ pathname: '/webhooks/google/p1', search: '', isAuthenticated: false }),
    ).toEqual({
      category: 'self_authenticated',
      action: 'allow',
    });
    expect(
      decideAccess({ pathname: '/api/trigger-sync/p1', search: '', isAuthenticated: false }),
    ).toEqual({
      category: 'self_authenticated',
      action: 'allow',
    });
  });

  it('returns 401 unauthorized for unauthenticated protected API routes', () => {
    expect(decideAccess({ pathname: '/api/auth/me', search: '', isAuthenticated: false })).toEqual({
      category: 'session_protected',
      action: 'unauthorized',
      status: 401,
    });
    expect(decideAccess({ pathname: '/api/profiles', search: '?all=1', isAuthenticated: false })).toEqual({
      category: 'session_protected',
      action: 'unauthorized',
      status: 401,
    });
  });

  it('redirects unauthenticated protected UI routes safely to /login', () => {
    expect(decideAccess({ pathname: '/', search: '', isAuthenticated: false })).toEqual({
      category: 'session_protected',
      action: 'redirect',
      status: 302,
      location: '/login',
    });
    expect(
      decideAccess({ pathname: '/profiles/1', search: '?tab=mail', isAuthenticated: false }),
    ).toEqual({
      category: 'session_protected',
      action: 'redirect',
      status: 302,
      location: '/login?next=%2Fprofiles%2F1%3Ftab%3Dmail',
    });
  });

  it('strips open-redirect attempts when redirecting unauthenticated UI requests', () => {
    expect(
      decideAccess({ pathname: '//evil.com', search: '', isAuthenticated: false }),
    ).toEqual({
      category: 'session_protected',
      action: 'redirect',
      status: 302,
      location: '/login',
    });
    expect(
      decideAccess({ pathname: '/\\evil.com', search: '', isAuthenticated: false }),
    ).toEqual({
      category: 'session_protected',
      action: 'redirect',
      status: 302,
      location: '/login',
    });
  });

  it('allows authenticated requests to protected UI and API routes', () => {
    expect(decideAccess({ pathname: '/', search: '', isAuthenticated: true })).toEqual({
      category: 'session_protected',
      action: 'allow',
    });
    expect(decideAccess({ pathname: '/api/auth/me', search: '', isAuthenticated: true })).toEqual({
      category: 'session_protected',
      action: 'allow',
    });
  });
});
