import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReverseLabel,
  confirmCoordinateEndpoint,
  emptyEndpointField,
  invalidateEndpoint,
  replaceItinerary,
  selectEndpointCandidate
} from '../src/components/journeyWorkflow.ts';

const candidate = (id, name, latitude, longitude) => ({
  id, name, display_name: `${name}, Auckland`, secondary_text: 'Auckland',
  latitude, longitude, category: 'place', type: 'suburb', attribution: 'OSM'
});

test('ambiguous candidates require an explicit choice and editing clears stale coordinates', () => {
  const field = { ...emptyEndpointField(), query: 'Queen', candidates: [candidate('1', 'Queen Street', -36.85, 174.76), candidate('2', 'Queens Road', -36.87, 174.77)] };
  assert.equal(field.selected, null);
  const selected = selectEndpointCandidate(field, field.candidates[1]);
  assert.equal(selected.selected.place_id, '2');
  const dirty = invalidateEndpoint(selected, 'Queens Ro');
  assert.equal(dirty.selected, null);
  assert.deepEqual(dirty.candidates, []);
  assert.equal(dirty.searching, false, 'editing alone never starts an upstream search');
});

test('map confirmation is immediately valid even when reverse lookup never supplies a label', () => {
  const selected = confirmCoordinateEndpoint(emptyEndpointField(), 174.7633, -36.8485);
  assert.equal(selected.selected.confirmed, true);
  assert.equal(selected.selected.name, '-36.84850, 174.76330');
});

test('reverse lookup improves the label without replacing confirmed map coordinates', () => {
  const field = confirmCoordinateEndpoint(emptyEndpointField(), 174.76331, -36.84851);
  const labelled = applyReverseLabel(field, candidate('1', 'Nearby address', -36.848, 174.764), 174.76331, -36.84851);

  assert.equal(labelled.selected.name, 'Nearby address, Auckland');
  assert.equal(labelled.selected.latitude, -36.84851);
  assert.equal(labelled.selected.longitude, 174.76331);
});

test('selecting another option atomically replaces rather than accumulates locked legs', () => {
  const first = { id: 'first', legs: [{ type: 'transit' }], departure_time: '', duration_seconds: 1, transfers: 0 };
  const next = { ...first, id: 'next', transfers: 2, legs: [{ type: 'transit' }, { type: 'transit' }, { type: 'transit' }] };
  const selected = replaceItinerary(first, next);
  assert.equal(selected.id, 'next');
  assert.equal(selected.legs.length, 3);
});
