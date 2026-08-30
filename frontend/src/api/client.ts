import type {
  AlertItem,
  AuthResponse,
  CacheMeta,
  DepartureItem,
  FeedResponse,
  RouteItem,
  RouteShape,
  RealtimeRefreshEvent,
  RouteDirection,
  StopItem,
  RouteTripItem,
  TripUpdateItem,
  User,
  VehicleItem
} from '../types/domain';
import type { JourneyEndpoint, JourneyPlanResponse, PlaceCandidate } from '../types/domain';

const API_BASE = (import.meta.env?.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
let onUnauthorized: (() => void) | null = null;

type RequestOptions = RequestInit;
type ApiErrorDetail = {
  code?: string;
  message?: string;
  retryable?: boolean;
  retry_after_seconds?: number;
};

const DATABASE_START_MAX_WAIT_MS = 5 * 60 * 1000;
let databaseStarting = false;

function announceDatabaseState(state: 'starting' | 'ready') {
  if (state === 'starting' && databaseStarting) return;
  if (state === 'ready' && !databaseStarting) return;
  databaseStarting = state === 'starting';
  window.dispatchEvent(new CustomEvent('database-power-state', { detail: { state } }));
}

function waitForRetry(milliseconds: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ApiError extends Error {
  status: number;
  code?: string;
  retryable: boolean;
  retryAfterSeconds?: number;

  constructor(status: number, message: string, detail: ApiErrorDetail = {}) {
    super(message);
    this.status = status;
    this.code = detail.code;
    this.retryable = Boolean(detail.retryable);
    this.retryAfterSeconds = detail.retry_after_seconds;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const startedAt = Date.now();
  while (true) {
    const response = await fetch(`${API_BASE}${path}`, { ...options, credentials: 'include', headers });
    if (!response.ok) {
      let message = response.statusText;
      let detail: ApiErrorDetail = {};
      const body = await response.text();
      if (body) {
        try {
          const payload = JSON.parse(body);
          detail = typeof payload.detail === 'object' && payload.detail ? payload.detail : {};
          message = typeof payload.detail === 'string' ? payload.detail : detail.message ?? JSON.stringify(payload);
        } catch {
          message = body;
        }
      }
      if (detail.code === 'database_starting' && detail.retryable && Date.now() - startedAt < DATABASE_START_MAX_WAIT_MS) {
        announceDatabaseState('starting');
        const retrySeconds = detail.retry_after_seconds ?? (Number(response.headers.get('Retry-After')) || 5);
        await waitForRetry(Math.max(1, retrySeconds) * 1000, options.signal);
        continue;
      }
      if (response.status === 401 && !path.endsWith('/login')) onUnauthorized?.();
      throw new ApiError(response.status, message || response.statusText, detail);
    }

    announceDatabaseState('ready');
    return response.json() as Promise<T>;
  }
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export function login(email: string, password: string) {
  return request<AuthResponse>('/api/auth/v1/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

export function register(email: string, password: string) {
  return request<AuthResponse>('/api/auth/v1/register', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

export function me() {
  return request<User>('/api/auth/v1/me');
}

export async function logout() {
  const response = await fetch(`${API_BASE}/api/auth/v1/logout`, {
    method: 'POST',
    credentials: 'include'
  });
  if (!response.ok) throw new ApiError(response.status, response.statusText || 'Logout failed');
}

export function activeFeed(signal?: AbortSignal) {
  return request<FeedResponse>('/api/static/v1/feed', { signal });
}

export function routes(feedVersion: string, search = '', limit = 500, offset = 0, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (search.trim()) query.set('search', search.trim());
  return request<{ feed_version: string; items: RouteItem[]; page: { total: number } }>(
    `/api/static/v1/feeds/${encodeURIComponent(feedVersion)}/routes?${query}`,
    { signal }
  );
}

export async function allRoutes(feedVersion: string, signal?: AbortSignal) {
  const limit = 500;
  const first = await routes(feedVersion, '', limit, 0, signal);
  const items = [...first.items];
  while (items.length < first.page.total) {
    const page = await routes(feedVersion, '', limit, items.length, signal);
    if (page.items.length === 0) break;
    items.push(...page.items);
  }
  return { ...first, items };
}

export function routeShapes(feedVersion: string, routeId: string, signal?: AbortSignal) {
  return request<{ feed_version: string; route_id: string; items: RouteShape[] }>(
    `/api/static/v1/feeds/${encodeURIComponent(feedVersion)}/routes/${encodeURIComponent(routeId)}/shapes`,
    { signal }
  );
}

export function routeStops(feedVersion: string, routeId: string, signal?: AbortSignal) {
  return request<{ feed_version: string; route_id: string; directions: RouteDirection[] }>(
    `/api/static/v1/feeds/${encodeURIComponent(feedVersion)}/routes/${encodeURIComponent(routeId)}/stops`,
    { signal }
  );
}

export function tripShape(feedVersion: string, tripId: string, signal?: AbortSignal) {
  return request<{ feed_version: string } & RouteShape>(
    `/api/static/v1/feeds/${encodeURIComponent(feedVersion)}/trips/${encodeURIComponent(tripId)}/shape`,
    { signal }
  );
}

export function tripStops(feedVersion: string, tripId: string, signal?: AbortSignal) {
  return request<{ feed_version: string } & RouteDirection>(
    `/api/static/v1/feeds/${encodeURIComponent(feedVersion)}/trips/${encodeURIComponent(tripId)}/stops`,
    { signal }
  );
}

function realtimeFilter(routeIds: string[], directionId?: number | null) {
  return {
    route_ids: routeIds,
    ...(directionId == null ? {} : { direction_ids: [directionId] })
  };
}

export function vehicles(routeIds: string[], directionId?: number | null, signal?: AbortSignal) {
  return request<{ feed_version?: string | null; items: VehicleItem[]; generated_at?: string | null }>('/api/realtime/v1/vehicles', {
    method: 'POST',
    signal,
    body: JSON.stringify({ realtime_filter: realtimeFilter(routeIds, directionId) })
  });
}

export function vehiclesForTrips(tripIds: string[], signal?: AbortSignal) {
  return request<{ feed_version?: string | null; items: VehicleItem[]; generated_at?: string | null }>('/api/realtime/v1/vehicles', {
    method: 'POST',
    signal,
    body: JSON.stringify({ realtime_filter: { trip_ids: tripIds } })
  });
}

export function alerts(routeIds: string[], signal?: AbortSignal) {
  return request<{ feed_version?: string | null; items: AlertItem[]; generated_at?: string | null }>('/api/realtime/v1/alerts', {
    method: 'POST',
    signal,
    body: JSON.stringify({ realtime_filter: { route_ids: routeIds } })
  });
}

export function tripUpdates(routeIds: string[], stopIds: string[] = [], tripIds: string[] = [], directionId?: number | null, signal?: AbortSignal) {
  return request<{ feed_version?: string | null; items: TripUpdateItem[]; generated_at?: string | null }>('/api/realtime/v1/trip-updates', {
    method: 'POST',
    signal,
    body: JSON.stringify({ realtime_filter: { ...realtimeFilter(routeIds, directionId), stop_ids: stopIds, trip_ids: tripIds } })
  });
}

export async function streamRealtime(
  routeIds: string[],
  onRefresh: (event: RealtimeRefreshEvent) => void,
  signal: AbortSignal
) {
  const query = new URLSearchParams();
  for (const routeId of routeIds) query.append('route_id', routeId);
  const response = await fetch(`${API_BASE}/api/realtime/v1/stream?${query}`, {
    credentials: 'include',
    headers: { Accept: 'text/event-stream' },
    signal
  });
  if (!response.ok) {
    if (response.status === 401) onUnauthorized?.();
    throw new ApiError(response.status, response.statusText || 'Realtime stream failed');
  }
  if (!response.body) throw new Error('Realtime stream has no response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) onRefresh(JSON.parse(data) as RealtimeRefreshEvent);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export function nearbyStops(lat: number, lon: number, radiusM = 900) {
  return request<{ feed_version: string; items: StopItem[]; cache: CacheMeta }>('/api/discovery/v1/nearby-stops', {
    method: 'POST',
    body: JSON.stringify({ spatial: { lat, lon, radius_m: radiusM, limit: 16 } })
  });
}

export function routesOnStops(stopIds: string[], signal?: AbortSignal) {
  return request<{ feed_version: string; items: RouteItem[] }>('/api/discovery/v1/routes-on-stops', {
    method: 'POST',
    signal,
    body: JSON.stringify({ stop_filter: { stop_ids: stopIds } })
  });
}

export function nextDepartures(
  stopIds: string[],
  routeIds: string[],
  signal?: AbortSignal,
  maxResults = 8,
  directionIds: number[] = [],
  feedVersion?: string
) {
  return request<{ feed_version: string; service_date?: string; items: DepartureItem[] }>('/api/timetable/v1/next-departures', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      stop_filter: { stop_ids: stopIds, route_ids: routeIds, direction_ids: directionIds },
      time_window: { max_results: maxResults },
      ...(feedVersion ? { feed_version: feedVersion } : {})
    })
  });
}

export function routeTrips(routeId: string, directionId?: number | null, signal?: AbortSignal, maxResults = 24) {
  const query = new URLSearchParams({ route_id: routeId, max_results: String(maxResults) });
  if (directionId != null) query.set('direction_id', String(directionId));
  return request<{ feed_version: string; service_date?: string; items: RouteTripItem[] }>(
    `/api/timetable/v1/route-trips?${query}`,
    { signal }
  );
}

export function favouriteRoutes(signal?: AbortSignal) {
  return request<{ route_ids: string[] }>('/api/app/v1/favourite-routes', { signal });
}

export function addFavourite(routeId: string) {
  return request<{ route_ids: string[] }>(`/api/app/v1/favourite-routes/${encodeURIComponent(routeId)}`, {
    method: 'POST'
  });
}

export function removeFavourite(routeId: string) {
  return request<{ route_ids: string[] }>(`/api/app/v1/favourite-routes/${encodeURIComponent(routeId)}`, {
    method: 'DELETE'
  });
}

export function searchPlaces(query: string, limit = 8, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return request<{ query: string; candidates: PlaceCandidate[]; attribution: string; cache: string }>(
    `/api/geocoding/v1/search?${params}`,
    { signal }
  );
}

export function reversePlace(lat: number, lon: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  return request<{ latitude: number; longitude: number; candidate: PlaceCandidate | null; attribution: string; cache: string }>(
    `/api/geocoding/v1/reverse?${params}`,
    { signal }
  );
}

export function planJourney(
  origin: JourneyEndpoint,
  destination: JourneyEndpoint,
  departureTime: string,
  optionLimit = 5,
  signal?: AbortSignal
) {
  return request<JourneyPlanResponse>('/api/journeys/v1/plan', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      origin,
      destination,
      departure_time: departureTime,
      option_limit: optionLimit
    })
  });
}
