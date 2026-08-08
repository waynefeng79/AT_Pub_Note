import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeVehicleItems,
  fallbackGeometry,
  plannedRouteState,
  presentationCoordinates,
  presentationGeoJson,
  retainedRouteIds,
  toggleLockedRouteIds,
  uniqueRouteDirectionKeys
} from '../src/components/transitMapModel.ts';

const point = (name, longitude, latitude) => ({ name, longitude, latitude });
const leg = (routeId, directionId = null) => ({
  type: 'transit', route_id: routeId, route_short_name: routeId, route_long_name: routeId,
  route_type: 3, trip_id: `trip-${routeId}`, direction_id: directionId, service_date: '2026-08-08',
  from: point('A', 174.7, -36.8), to: point('B', 174.8, -36.9),
  scheduled_departure: '2026-08-08T09:00:00+12:00', scheduled_arrival: '2026-08-08T09:30:00+12:00'
});

test('route monitoring is deduplicated by route and direction', () => {
  assert.deepEqual(uniqueRouteDirectionKeys([leg('70', 0), leg('70', 0), leg('70', 1)]), [
    { routeId: '70', directionId: 0 },
    { routeId: '70', directionId: 1 }
  ]);
});

test('main-map route locking preserves five-route limit and selected-route persistence', () => {
  const locked = ['1', '2', '3', '4', '5'];
  assert.deepEqual(toggleLockedRouteIds(locked, '6'), { routeIds: locked, rejected: true });
  assert.deepEqual(toggleLockedRouteIds(locked, '3'), { routeIds: ['1', '2', '4', '5'], rejected: false });
  assert.deepEqual(retainedRouteIds(['1', '2'], '2'), ['1', '2']);
  assert.deepEqual(retainedRouteIds(['1', '2'], '3'), ['1', '2', '3']);
});

test('planning replaces the workspace route set with unique locked journey routes', () => {
  const option = {
    id: 'journey', departure_time: '2026-08-08T09:00:00+12:00', duration_seconds: 3600, transfers: 2,
    legs: [leg('70', 0), leg('75', 1), leg('70', 1)]
  };
  assert.deepEqual(plannedRouteState(option), {
    routeIds: ['70', '75'],
    directionByRoute: { '70': 0, '75': 1 }
  });
});

test('vehicle presentation keeps the newest observation per identity', () => {
  const oldItem = { vehicle_id: '1', route_id: '70', trip_id: 't1', timestamp: 10, position: {} };
  const newItem = { ...oldItem, timestamp: 20 };
  assert.deepEqual(dedupeVehicleItems([oldItem, newItem]), [newItem]);
});

test('missing trip shape falls back to ordered stops, then leg endpoints', () => {
  const routeLeg = leg('NX1', 0);
  assert.deepEqual(fallbackGeometry(routeLeg, [
    { stop_id: 'a', stop_name: 'A', stop_lon: 174.71, stop_lat: -36.81 },
    { stop_id: 'b', stop_name: 'B', stop_lon: 174.72, stop_lat: -36.82 }
  ]).coordinates, [[174.71, -36.81], [174.72, -36.82]]);
  assert.deepEqual(fallbackGeometry(routeLeg, []).coordinates, [[174.7, -36.8], [174.8, -36.9]]);
});

test('presentation bounds include endpoints, shapes, and stops', () => {
  const routeLeg = leg('75', 0);
  const coordinates = presentationCoordinates({
    id: 'v:o', origin: { name: 'Origin', latitude: -36.8, longitude: 174.6, confirmed: true },
    destination: { name: 'Destination', latitude: -36.9, longitude: 174.9, confirmed: true },
    transit: [{ leg: routeLeg, geometry: fallbackGeometry(routeLeg, []), stops: [], usedFallbackGeometry: true }]
  });
  assert.ok(coordinates.some(([lon]) => lon === 174.6));
  assert.ok(coordinates.some(([lon]) => lon === 174.9));
  assert.ok(coordinates.some(([lon]) => lon === 174.7));
});

test('journey GeoJSON retains every trip shape and identifies boarding and transfer stops', () => {
  const first = { ...leg('70', 0), from: { ...point('A', 174.7, -36.8), stop_id: 'a' }, to: { ...point('X', 174.75, -36.85), stop_id: 'x' } };
  const second = { ...leg('75', 1), from: { ...point('X', 174.75, -36.85), stop_id: 'x' }, to: { ...point('B', 174.8, -36.9), stop_id: 'b' } };
  const stop = (stop_id, stop_name, stop_lon, stop_lat) => ({ stop_id, stop_name, stop_lon, stop_lat });
  const presentation = {
    id: 'v:two-leg', origin: { name: 'Origin', latitude: -36.8, longitude: 174.7, confirmed: true },
    destination: { name: 'Destination', latitude: -36.9, longitude: 174.8, confirmed: true },
    transit: [
      { leg: first, geometry: fallbackGeometry(first, []), stops: [stop('a', 'A', 174.7, -36.8), stop('x', 'X', 174.75, -36.85)], usedFallbackGeometry: false },
      { leg: second, geometry: fallbackGeometry(second, []), stops: [stop('x', 'X', 174.75, -36.85), stop('b', 'B', 174.8, -36.9)], usedFallbackGeometry: false }
    ]
  };
  const data = presentationGeoJson(presentation);
  assert.equal(data.shapes.features.length, 2);
  assert.equal(data.shapes.features[0].properties.color, '#2563eb');
  assert.equal(data.stops.features.find((item) => item.properties.stopId === 'a').properties.role, 'boarding');
  assert.equal(data.stops.features.filter((item) => item.properties.stopId === 'x').every((item) => item.properties.role === 'transfer'), true);
});
