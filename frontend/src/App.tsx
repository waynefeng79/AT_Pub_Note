import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { logout, me, setUnauthorizedHandler } from './api/client';
import type { Session } from './auth/session';
import { LoginPage } from './pages/LoginPage';

const MapPage = lazy(() => import('./pages/MapPage').then((module) => ({ default: module.MapPage })));

type RouteName = 'login' | 'map';

function routeFromLocation(session: Session | null): RouteName {
  const hash = window.location.hash.replace('#', '');
  if (hash === '/login') return 'login';
  if (hash === '/map') return session ? 'map' : 'login';
  return session ? 'map' : 'login';
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState<RouteName>('login');
  const [booting, setBooting] = useState(true);

  const endSession = useCallback(() => {
    setSession(null);
    setRoute('login');
    window.location.hash = '/login';
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(endSession);
    return () => setUnauthorizedHandler(null);
  }, [endSession]);

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromLocation(session));
    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, [session]);

  useEffect(() => {
    async function verify() {
      try {
        const user = await me();
        const verified = { email: user.email };
        setSession(verified);
        setRoute('map');
        window.location.hash = '/map';
      } catch {
        endSession();
      } finally {
        setBooting(false);
      }
    }
    void verify();
  }, [endSession]);

  const page = useMemo(() => {
    if (booting) {
      return (
        <main className="boot-screen">
          <Loader2 className="spin" size={28} />
          <span>Opening Auckland network</span>
        </main>
      );
    }
    if (!session || route === 'login') {
      return (
        <LoginPage
          onAuthenticated={(next) => {
            setSession(next);
            setRoute('map');
            window.location.hash = '/map';
          }}
        />
      );
    }
    return (
      <Suspense fallback={<main className="boot-screen"><Loader2 className="spin" size={28} /></main>}>
        <MapPage
          session={session}
          onLogout={() => {
            void logout().finally(endSession);
          }}
        />
      </Suspense>
    );
  }, [booting, endSession, route, session]);

  return page;
}
