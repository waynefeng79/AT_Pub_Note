import { alerts, ApiError, nextDepartures, tripShape, tripStops, tripUpdates, vehicles, vehiclesForTrips } from '../api/client.ts';
import type { JourneyEndpoint, JourneyOption, StopItem, TransitJourneyLeg, TripUpdateItem, VehicleItem } from '../types/domain';
import {
  dedupeVehicleItems,
  fallbackGeometry,
  transitLegs,
  uniqueRouteDirectionKeys,
  uniqueRouteIds,
  uniqueTripIds,
  type JourneyMapPresentation,
  type JourneyRealtime,
  type TransitLegPresentation
} from './transitMapModel.ts';

export async function loadJourneyPresentation(
  feedVersion: string,
  option: JourneyOption,
  origin: JourneyEndpoint,
  destination: JourneyEndpoint,
  signal?: AbortSignal
): Promise<{ presentation: JourneyMapPresentation; partialErrors: string[] }> {
  const errors: string[] = [];
  const legs = transitLegs(option);
  const transit = await Promise.all(legs.map(async (leg): Promise<TransitLegPresentation> => {
    let stops: StopItem[];
    try {
      stops = (await tripStops(feedVersion, leg.trip_id, signal)).stops;
    } catch (error) {
      if (isExpiredFeedError(error)) throw error;
      stops = endpointStops(leg);
      errors.push(`The ordered stops for ${leg.route_short_name} are unavailable; showing its journey endpoints.`);
      console.warn('journey_map_layer_unavailable', { layer: 'trip-stops', tripId: leg.trip_id });
    }
    let geometry;
    let usedFallbackGeometry = false;
    try {
      geometry = (await tripShape(feedVersion, leg.trip_id, signal)).geometry;
    } catch (error) {
      if (isExpiredFeedError(error)) throw error;
      usedFallbackGeometry = true;
      geometry = fallbackGeometry(leg, stops);
      errors.push(`The detailed shape for ${leg.route_short_name} is unavailable; showing its stop path.`);
      console.warn('journey_map_layer_unavailable', { layer: 'trip-shape', tripId: leg.trip_id });
    }
    return { leg, geometry, stops, usedFallbackGeometry };
  }));
  return {
    presentation: {
      id: `${feedVersion}:${option.id}`,
      origin,
      destination,
      transit
    },
    partialErrors: errors
  };
}

export function isExpiredFeedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && /unknown feed version/i.test(error.message);
}

function endpointStops(leg: TransitJourneyLeg): StopItem[] {
  return [
    {
      stop_id: leg.from.stop_id ?? `${leg.trip_id}:boarding`,
      stop_name: leg.from.name,
      stop_lat: leg.from.latitude,
      stop_lon: leg.from.longitude,
      platform_code: leg.from.platform_code
    },
    {
      stop_id: leg.to.stop_id ?? `${leg.trip_id}:alighting`,
      stop_name: leg.to.name,
      stop_lat: leg.to.latitude,
      stop_lon: leg.to.longitude,
      platform_code: leg.to.platform_code
    }
  ];
}

async function settled<T>(promise: Promise<T>, message: string) {
  try {
    return { value: await promise, error: null };
  } catch {
    console.warn('journey_realtime_layer_unavailable', { message });
    return { value: null, error: message };
  }
}

type FeedScopedResponse = { feed_version?: string | null };

async function settledForFeed<T extends FeedScopedResponse>(
  promise: Promise<T>,
  expectedFeedVersion: string,
  unavailableMessage: string,
  mismatchMessage: string
) {
  const result = await settled(promise, unavailableMessage);
  if (!result.value || result.value.feed_version === expectedFeedVersion) return result;
  console.warn('journey_realtime_feed_mismatch', {
    expectedFeedVersion,
    actualFeedVersion: result.value.feed_version ?? null
  });
  return { value: null, error: mismatchMessage };
}

export async function loadJourneyRealtime(
  option: JourneyOption,
  expectedFeedVersion: string,
  signal?: AbortSignal
): Promise<JourneyRealtime> {
  const legs = transitLegs(option);
  const keys = uniqueRouteDirectionKeys(legs);
  const routeIds = uniqueRouteIds(legs);
  const tripIds = uniqueTripIds(legs);
  const [vehicleGroups, updates, alertResponse] = await Promise.all([
    Promise.all(keys.map((key) => settledForFeed(
      vehicles([key.routeId], key.directionId, signal),
      expectedFeedVersion,
      `Live vehicles for route ${key.routeId} are temporarily unavailable.`,
      `Live vehicles for route ${key.routeId} belong to a different timetable and were hidden.`
    ))),
    settledForFeed(
      tripUpdates(routeIds, [], tripIds, undefined, signal),
      expectedFeedVersion,
      'Live departure updates are temporarily unavailable.',
      'Live departure updates belong to a different timetable and were hidden.'
    ),
    settledForFeed(
      alerts(routeIds, signal),
      expectedFeedVersion,
      'Service alerts are temporarily unavailable.',
      'Service alerts belong to a different timetable and were hidden.'
    )
  ]);
  const partialErrors = [
    ...vehicleGroups.map((item) => item.error),
    updates.error,
    alertResponse.error
  ].filter((value): value is string => Boolean(value));
  const vehicleItems = vehicleGroups.flatMap((item) => item.value?.items ?? []);
  const generatedAt = vehicleGroups.find((item) => item.value?.generated_at)?.value?.generated_at
    ?? updates.value?.generated_at
    ?? alertResponse.value?.generated_at
    ?? null;
  return {
    vehicles: dedupeVehicleItems(vehicleItems),
    tripUpdates: updates.value?.items ?? [],
    alerts: alertResponse.value?.items ?? [],
    generatedAt,
    partialErrors
  };
}

export function legRealtimeUpdate(leg: TransitJourneyLeg, realtime: JourneyRealtime) {
  return realtime.tripUpdates.find((item) => item.trip_id === leg.trip_id);
}

export async function loadStopTransitDetail(
  stopId: string,
  routeIds: string[],
  directionIds: number[] = [],
  maxResults = 8,
  signal?: AbortSignal,
  expectedFeedVersion?: string
) {
  const departures = await nextDepartures([stopId], routeIds, signal, maxResults, directionIds, expectedFeedVersion);
  if (expectedFeedVersion && departures.feed_version !== expectedFeedVersion) {
    throw new Error('Stop timetable returned a different GTFS feed version.');
  }
  const tripIds = departures.items.map((item) => item.trip_id);
  const [updates, vehicleResult] = tripIds.length
    ? await Promise.all([tripUpdates([], [], tripIds, undefined, signal), vehiclesForTrips(tripIds, signal)])
    : [{ feed_version: departures.feed_version, items: [] as TripUpdateItem[] }, { feed_version: departures.feed_version, items: [] as VehicleItem[] }];
  const updatesMatch = updates.feed_version === departures.feed_version;
  const vehiclesMatch = vehicleResult.feed_version === departures.feed_version;
  return {
    feedVersion: departures.feed_version,
    serviceDate: departures.service_date,
    departures: departures.items,
    updates: new Map((updatesMatch ? updates.items : []).map((item) => [item.trip_id, item])),
    vehicles: new Map((vehiclesMatch ? vehicleResult.items : []).map((item) => [item.trip_id, item])),
    partialErrors: [
      ...(updatesMatch ? [] : ['Live departure updates belong to a different timetable and were hidden.']),
      ...(vehiclesMatch ? [] : ['Live vehicles belong to a different timetable and were hidden.'])
    ]
  };
}

export type StopTransitDetail = Awaited<ReturnType<typeof loadStopTransitDetail>>;
