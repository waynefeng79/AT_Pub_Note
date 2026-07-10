import http from 'k6/http';
import { check, group, sleep } from 'k6';

export const options = {
  stages: [
    { duration: __ENV.RAMP_UP || '1m', target: Number(__ENV.VUS || 20) },
    { duration: __ENV.HOLD || '3m', target: Number(__ENV.VUS || 20) },
    { duration: __ENV.RAMP_DOWN || '1m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<2000'],
  },
};

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const DEFAULT_LAT = Number(__ENV.LAT || -36.8485);
const DEFAULT_LON = Number(__ENV.LON || 174.7633);
const DEFAULT_RADIUS_M = Number(__ENV.RADIUS_M || 900);

function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

function authHeaders(token) {
  return token ? jsonHeaders({ Authorization: `Bearer ${token}` }) : jsonHeaders();
}

function isJsonResponse(response) {
  const contentType = response.headers['Content-Type'] || response.headers['content-type'] || '';
  return contentType.includes('application/json');
}

function parseJson(response, fallback = {}) {
  if (!isJsonResponse(response) || !response.body) return fallback;
  try {
    return response.json();
  } catch {
    return fallback;
  }
}

function logUnexpectedResponse(name, response, expected = [200]) {
  if (expected.includes(response.status) && isJsonResponse(response)) return;
  const contentType = response.headers['Content-Type'] || response.headers['content-type'] || 'unknown';
  const body = response.body ? response.body.slice(0, 250) : '';
  console.error(`${name} status=${response.status} content-type=${contentType} body=${body}`);
}

function getJson(name, path, params = {}) {
  const response = http.get(`${BASE_URL}${path}`, params);
  logUnexpectedResponse(name, response);
  check(response, {
    [`${name} status is 200`]: (r) => r.status === 200,
    [`${name} returns JSON`]: isJsonResponse,
  });
  return response;
}

function postJson(name, path, body, params = {}) {
  const response = http.post(`${BASE_URL}${path}`, JSON.stringify(body), params);
  logUnexpectedResponse(name, response);
  check(response, {
    [`${name} status is 200`]: (r) => r.status === 200,
    [`${name} returns JSON`]: isJsonResponse,
  });
  return response;
}

function authenticate() {
  if (__ENV.USER_TOKEN) return __ENV.USER_TOKEN;
  if (!__ENV.USER_EMAIL || !__ENV.USER_PASSWORD) return '';

  const response = http.post(
    `${BASE_URL}/api/auth/v1/login`,
    JSON.stringify({ email: __ENV.USER_EMAIL, password: __ENV.USER_PASSWORD }),
    { headers: jsonHeaders() }
  );
  logUnexpectedResponse('POST /api/auth/v1/login', response);
  check(response, {
    'login status is 200': (r) => r.status === 200,
    'login returns token': (r) => Boolean(parseJson(r).access_token),
  });
  return parseJson(response).access_token || '';
}

export function setup() {
  getJson('GET /health', '/health');

  const token = authenticate();
  const headers = authHeaders(token);
  const feedResponse = getJson('GET /api/static/v1/feed', '/api/static/v1/feed', { headers });
  const feed = parseJson(feedResponse);
  const feedVersion = __ENV.FEED_VERSION || feed.feed_version;

  const routesResponse = getJson(
    'GET /api/static/v1/feeds/:feed/routes',
    `/api/static/v1/feeds/${encodeURIComponent(feedVersion)}/routes?limit=50`,
    { headers }
  );
  const routeItems = parseJson(routesResponse).items || [];
  const route = routeItems.find((item) => item.route_id === __ENV.ROUTE_ID) || routeItems[0] || null;
  if (!route) throw new Error('No route available. Import GTFS data before running the stress test.');

  const stopsResponse = getJson(
    'GET /api/static/v1/feeds/:feed/routes/:route/stops',
    `/api/static/v1/feeds/${encodeURIComponent(feedVersion)}/routes/${encodeURIComponent(route.route_id)}/stops`,
    { headers }
  );
  const directions = parseJson(stopsResponse).directions || [];
  const direction = directions.find((item) => item.stops?.length > 0) || null;
  const stops = direction?.stops || [];
  const stop = stops.find((item) => item.stop_id === __ENV.STOP_ID) || stops[Math.floor(stops.length / 2)] || stops[0] || null;
  if (!stop) throw new Error(`No stops available for route ${route.route_id}.`);

  return {
    token,
    feedVersion,
    routeId: route.route_id,
    directionId: direction?.direction_id ?? null,
    stopId: stop.stop_id,
    lat: Number(__ENV.LAT || stop.stop_lat || DEFAULT_LAT),
    lon: Number(__ENV.LON || stop.stop_lon || DEFAULT_LON),
  };
}

export default function (data) {
  const headers = authHeaders(data.token);
  const directionIds = data.directionId == null ? [] : [data.directionId];
  const routeFilter = { route_ids: [data.routeId], direction_ids: directionIds };

  group('static GTFS browsing', () => {
    getJson('GET active feed', '/api/static/v1/feed', { headers });
    getJson(
      'GET route list',
      `/api/static/v1/feeds/${encodeURIComponent(data.feedVersion)}/routes?limit=100&search=${encodeURIComponent(__ENV.SEARCH || '')}`,
      { headers }
    );
    getJson(
      'GET route shapes',
      `/api/static/v1/feeds/${encodeURIComponent(data.feedVersion)}/routes/${encodeURIComponent(data.routeId)}/shapes`,
      { headers }
    );
    getJson(
      'GET route stops',
      `/api/static/v1/feeds/${encodeURIComponent(data.feedVersion)}/routes/${encodeURIComponent(data.routeId)}/stops`,
      { headers }
    );
  });

  sleep(0.5);

  group('realtime route state', () => {
    postJson('POST realtime vehicles', '/api/realtime/v1/vehicles', { realtime_filter: routeFilter }, { headers });
    postJson('POST realtime trip updates', '/api/realtime/v1/trip-updates', { realtime_filter: routeFilter }, { headers });
    postJson('POST realtime alerts', '/api/realtime/v1/alerts', { realtime_filter: { route_ids: [data.routeId] } }, { headers });
  });

  sleep(0.5);

  group('stop discovery and timetable', () => {
    const nearbyResponse = postJson(
      'POST nearby stops',
      '/api/discovery/v1/nearby-stops',
      { spatial: { lat: data.lat, lon: data.lon, radius_m: DEFAULT_RADIUS_M, limit: 16 } },
      { headers }
    );
    check(nearbyResponse, {
      'nearby stops has items array': (r) => Array.isArray(parseJson(r).items),
    });

    postJson(
      'POST routes on stops',
      '/api/discovery/v1/routes-on-stops',
      { stop_filter: { stop_ids: [data.stopId] } },
      { headers }
    );

    const departuresResponse = postJson(
      'POST next departures',
      '/api/timetable/v1/next-departures',
      {
        stop_filter: { stop_ids: [data.stopId], route_ids: [data.routeId] },
        time_window: { max_results: 12 },
      },
      { headers }
    );
    const tripIds = (parseJson(departuresResponse).items || []).slice(0, 8).map((item) => item.trip_id);
    if (tripIds.length > 0) {
      postJson(
        'POST vehicles for departure trips',
        '/api/realtime/v1/vehicles',
        { realtime_filter: { trip_ids: tripIds } },
        { headers }
      );
    }
  });

  sleep(Number(__ENV.SLEEP_SECONDS || 1));
}
