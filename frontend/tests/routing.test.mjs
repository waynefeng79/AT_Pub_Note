import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFromHash } from '../src/routing.ts';

test('authenticated journey deep links survive session verification when enabled', () => {
  assert.equal(routeFromHash('#/journey', true, true), 'journey');
});

test('journey deep links fall back safely when disabled or unauthenticated', () => {
  assert.equal(routeFromHash('#/journey', true, false), 'map');
  assert.equal(routeFromHash('#/journey', false, true), 'login');
});
