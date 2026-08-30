import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { logout, me, setUnauthorizedHandler } from './api/client';
import type { Session } from './auth/session';
import { LoginPage } from './pages/LoginPage';
import { routeFromHash, type RouteName } from './routing';

const MapPage = lazy(() => import('./pages/MapPage').then((module) => ({ default: module.MapPage })));

const JOURNEY_ENABLED = import.meta.env.VITE_JOURNEY_PLANNER_ENABLED === 'true';

function routeFromLocation(session: Session | null): RouteName {
  return routeFromHash(window.location.hash, Boolean(session), JOURNEY_ENABLED);
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState<RouteName>('login');
  const [booting, setBooting] = useState(true);
  const [databaseStarting, setDatabaseStarting] = useState(false);

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
    const updateDatabaseState = (event: Event) => {
      const state = (event as CustomEvent<{ state: 'starting' | 'ready' }>).detail.state;
      setDatabaseStarting(state === 'starting');
    };
    window.addEventListener('database-power-state', updateDatabaseState);
    return () => window.removeEventListener('database-power-state', updateDatabaseState);
  }, []);

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
        const nextRoute = routeFromLocation(verified);
        setRoute(nextRoute);
        window.location.hash = `/${nextRoute}`;
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
          <span>{databaseStarting ? 'Starting database service' : 'Opening Auckland network'}</span>
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
    const goTo = (next: 'map' | 'journey') => {
      setRoute(next);
      window.location.hash = `/${next}`;
    };
    return (
      <Suspense fallback={<main className="boot-screen"><Loader2 className="spin" size={28} /></main>}>
        <MapPage
          session={session}
          controlMode={route === 'journey' && JOURNEY_ENABLED ? 'journey' : 'map'}
          onControlModeChange={JOURNEY_ENABLED ? goTo : undefined}
          onLogout={() => void logout().finally(endSession)}
        />
      </Suspense>
    );
  }, [booting, databaseStarting, endSession, route, session]);

  return (
    <>
      {page}
      {!booting && databaseStarting && (
        <div className="database-starting" role="status">
          <Loader2 className="spin" size={18} />
          <span>Starting database service…</span>
        </div>
      )}
    </>
  );
}
