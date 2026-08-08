import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpiredFeedError, loadJourneyPresentation, loadJourneyRealtime } from '../src/components/transitData.ts';

const transitLeg = (number) => ({
  type: 'transit',
  route_id: `R${number}`,
  route_short_name: `R${number}`,
  route_long_name: `Route ${number}`,
  route_type: 3,
  route_color: '0072CE',
  trip_id: `T${number}`,
  direction_id: 0,
  shape_id: `shape-${number}`,
  service_date: '2026-08-10',
  from: { name: `Stop ${number}`, stop_id: `S${number}`, latitude: -36.85, longitude: 174.76 + number / 100 },
  to: { name: `Stop ${number + 1}`, stop_id: `S${number + 1}`, latitude: -36.84, longitude: 174.77 + number / 100 },
  scheduled_departure: '2026-08-10T08:00:00+12:00',
  scheduled_arrival: '2026-08-10T08:20:00+12:00'
});

const option = {
  id: 'option-1', departure_time: '', duration_seconds: 1200, transfers: 0,
  legs: [transitLeg(1)]
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

test('journey realtime hides every dataset from a different feed', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = String(url);
    if (path.includes('/vehicles')) return jsonResponse({ feed_version: 'new-feed', items: [] });
    if (path.includes('/trip-updates')) return jsonResponse({ feed_version: 'new-feed', items: [] });
    return jsonResponse({ feed_version: 'new-feed', items: [] });
  });

  const result = await loadJourneyRealtime(option, 'planned-feed');

  assert.deepEqual(result.vehicles, []);
  assert.deepEqual(result.tripUpdates, []);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.partialErrors.length, 3);
});

test('one failed static layer preserves the scheduled transit leg', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = String(url);
    if (path.endsWith('/stops')) return jsonResponse({ status: 'failure' }, 503);
    return jsonResponse({
      feed_version: 'planned-feed',
      shape_id: 'shape-1',
      geometry: { type: 'LineString', coordinates: [[174.77, -36.85], [174.78, -36.84]] }
    });
  });

  const result = await loadJourneyPresentation(
    'planned-feed', option,
    { name: 'Origin', latitude: -36.85, longitude: 174.77, confirmed: true },
    { name: 'Destination', latitude: -36.84, longitude: 174.78, confirmed: true }
  );

  assert.equal(result.presentation.transit.length, 1);
  assert.equal(result.presentation.transit[0].stops.length, 2);
  assert.match(result.partialErrors[0], /ordered stops/i);
});

test('an expired planned feed remains distinguishable from a missing shape', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ detail: 'Unknown feed version' }, 404));

  await assert.rejects(
    loadJourneyPresentation(
      'expired-feed', option,
      { name: 'Origin', latitude: -36.85, longitude: 174.77, confirmed: true },
      { name: 'Destination', latitude: -36.84, longitude: 174.78, confirmed: true }
    ),
    (error) => isExpiredFeedError(error)
  );
});
