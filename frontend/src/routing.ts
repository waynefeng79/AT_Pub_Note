export type RouteName = 'login' | 'map' | 'journey';

export function routeFromHash(hash: string, hasSession: boolean, journeyEnabled: boolean): RouteName {
  const path = hash.replace('#', '');
  if (path === '/login') return 'login';
  if (path === '/journey') return hasSession && journeyEnabled ? 'journey' : hasSession ? 'map' : 'login';
  if (path === '/map') return hasSession ? 'map' : 'login';
  return hasSession ? 'map' : 'login';
}
