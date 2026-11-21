import { useEffect, useState } from 'react';
import { sanitizeNextPath } from '../shared/redirect.js';
import { AppShell } from './components/AppShell.js';
import { LoginPage } from './components/LoginPage.js';
import {
  getCurrentAdmin,
  logoutAdmin,
  type AdminSession,
} from './lib/api.js';

type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'authenticated'; readonly admin: AdminSession };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let active = true;

    getCurrentAdmin()
      .then((admin) => {
        if (!active) {
          return;
        }
        if (admin) {
          if (window.location.pathname === '/login') {
            const nextParam = new URLSearchParams(window.location.search).get('next');
            window.history.replaceState({}, '', sanitizeNextPath(nextParam));
          }
          setAuth({ status: 'authenticated', admin });
        } else {
          setAuth({ status: 'unauthenticated' });
        }
      })
      .catch(() => {
        if (active) {
          setAuth({ status: 'unauthenticated' });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  function handleLoginSuccess(username: string) {
    const nextParam = new URLSearchParams(window.location.search).get('next');
    window.history.replaceState({}, '', sanitizeNextPath(nextParam));
    setAuth({ status: 'authenticated', admin: { username } });
  }

  async function handleLogout() {
    await logoutAdmin();
    window.history.replaceState({}, '', '/login');
    setAuth({ status: 'unauthenticated' });
  }

  if (auth.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  if (auth.status === 'unauthenticated') {
    return <LoginPage onSuccess={handleLoginSuccess} />;
  }

  return <AppShell username={auth.admin.username} onLogout={handleLogout} />;
}
