import type { FeatureCollection, LineString, Point } from 'geojson';
import type {
  AlertItem,
  JourneyEndpoint,
  JourneyOption,
  StopItem,
  TransitJourneyLeg,
  TripUpdateItem,
  VehicleItem
} from '../types/domain';

export type RouteDirectionKey = {
  routeId: string;
  directionId: number | null;
};

export type TransitLegPresentation = {
  leg: TransitJourneyLeg;
  geometry: LineString;
  stops: StopItem[];
  usedFallbackGeometry: boolean;
};

export type JourneyMapPresentation = {
  id: string;
  origin: JourneyEndpoint;
  destination: JourneyEndpoint;
  transit: TransitLegPresentation[];
};

export type JourneyRealtime = {
  vehicles: VehicleItem[];
  tripUpdates: TripUpdateItem[];
  alerts: AlertItem[];
  generatedAt: string | null;
  partialErrors: string[];
};

export function toggleLockedRouteIds(current: string[], routeId: string, maximum = 5) {
  if (current.includes(routeId)) return { routeIds: current.filter((id) => id !== routeId), rejected: false };
  if (current.length >= maximum) return { routeIds: current, rejected: true };
  return { routeIds: [...current, routeId], rejected: false };
}

export function retainedRouteIds(lockedRouteIds: string[], selectedRouteId: string) {
  return Array.from(new Set([...lockedRouteIds, selectedRouteId]));
}

export function transitLegs(option: JourneyOption): TransitJourneyLeg[] {
  return option.legs;
}

export function plannedRouteState(option: JourneyOption) {
  const routeIds: string[] = [];
  const directionByRoute: Record<string, number | null> = {};
  for (const leg of transitLegs(option)) {
    if (!routeIds.includes(leg.route_id)) routeIds.push(leg.route_id);
    if (!(leg.route_id in directionByRoute)) directionByRoute[leg.route_id] = leg.direction_id ?? null;
  }
  return { routeIds, directionByRoute };
}

export function uniqueRouteDirectionKeys(legs: TransitJourneyLeg[]): RouteDirectionKey[] {
  const seen = new Set<string>();
  const result: RouteDirectionKey[] = [];
  for (const leg of legs) {
    const key = `${leg.route_id}:${leg.direction_id ?? 'none'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ routeId: leg.route_id, directionId: leg.direction_id ?? null });
  }
  return result;
}

export function uniqueRouteIds(legs: TransitJourneyLeg[]): string[] {
  return Array.from(new Set(legs.map((leg) => leg.route_id)));
}

export function uniqueTripIds(legs: TransitJourneyLeg[]): string[] {
  return Array.from(new Set(legs.map((leg) => leg.trip_id)));
}

export function vehicleLabel(vehicle: VehicleItem | undefined) {
  if (!vehicle) return 'No vehicle';
  if (vehicle.vehicle_label) return vehicle.vehicle_label;
  return vehicle.vehicle_id ? `Vehicle ${vehicle.vehicle_id}` : 'Vehicle assigned';
}

export function vehicleIdentityKey(vehicle: VehicleItem) {
  const identity =
    vehicle.trip_id ||
    vehicle.vehicle_id ||
    vehicle.vehicle_label ||
    vehicle.vehicle_license_plate;
  return String(identity || '').trim();
}

export function dedupeVehicleItems(items: VehicleItem[], limit = 80) {
  const byIdentity = new Map<string, VehicleItem>();
  for (const item of items) {
    const key = vehicleIdentityKey(item);
    if (!key) continue;
    const existing = byIdentity.get(key);
    if (!existing || (item.timestamp ?? 0) >= (existing.timestamp ?? 0)) {
      byIdentity.set(key, item);
    }
  }
  return Array.from(byIdentity.values()).slice(0, limit);
}

export function findMatchingVehicle(items: VehicleItem[], vehicle: VehicleItem) {
  const key = vehicleIdentityKey(vehicle);
  return key ? items.find((item) => vehicleIdentityKey(item) === key) : undefined;
}

export function fallbackGeometry(leg: TransitJourneyLeg, stops: StopItem[]): LineString {
  const coordinates = stops
    .map((stop) => [stop.stop_lon, stop.stop_lat] as [number, number])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (coordinates.length >= 2) return { type: 'LineString', coordinates };
  return {
    type: 'LineString',
    coordinates: [
      [leg.from.longitude, leg.from.latitude],
      [leg.to.longitude, leg.to.latitude]
    ]
  };
}

export function presentationCoordinates(presentation: JourneyMapPresentation): [number, number][] {
  const coordinates: [number, number][] = [
    [presentation.origin.longitude, presentation.origin.latitude],
    [presentation.destination.longitude, presentation.destination.latitude]
  ];
  for (const item of presentation.transit) {
    coordinates.push(...item.geometry.coordinates.map((point) => [point[0], point[1]] as [number, number]));
    coordinates.push(...item.stops.map((stop) => [stop.stop_lon, stop.stop_lat] as [number, number]));
  }
  return coordinates.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

export function presentationGeoJson(presentation: JourneyMapPresentation) {
  const shapes: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: presentation.transit.map((item, index) => ({
      type: 'Feature',
      id: index,
      properties: {
        index,
        routeId: item.leg.route_id,
        color: `#${(item.leg.route_color || '2563eb').replace('#', '')}`
      },
      geometry: item.geometry
    }))
  };
  const lastLegIndex = presentation.transit.length - 1;
  const stops: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: presentation.transit.flatMap((item, legIndex) => item.stops.map((stop) => {
      const boarding = stop.stop_id === item.leg.from.stop_id;
      const alighting = stop.stop_id === item.leg.to.stop_id;
      const role = (boarding && legIndex > 0) || (alighting && legIndex < lastLegIndex)
        ? 'transfer'
        : boarding ? 'boarding' : alighting ? 'alighting' : 'stop';
      return {
        type: 'Feature' as const,
        properties: { legIndex, stopId: stop.stop_id, name: stop.stop_name, role },
        geometry: { type: 'Point' as const, coordinates: [stop.stop_lon, stop.stop_lat] }
      };
    }))
  };
  return { shapes, stops };
}

export function formatOccupancyStatus(status: string | number | null | undefined) {
  if (status == null || status === '') return '-';
  const labels: Record<string, string> = {
    '0': 'Empty', '1': 'Many seats available', '2': 'Few seats available',
    '3': 'Standing room only', '4': 'Very crowded', '5': 'Full',
    '6': 'Not accepting passengers', '7': 'Occupancy unavailable',
    EMPTY: 'Empty', MANY_SEATS_AVAILABLE: 'Many seats available',
    FEW_SEATS_AVAILABLE: 'Few seats available', STANDING_ROOM_ONLY: 'Standing room only',
    CRUSHED_STANDING_ROOM_ONLY: 'Very crowded', FULL: 'Full',
    NOT_ACCEPTING_PASSENGERS: 'Not accepting passengers', NO_DATA_AVAILABLE: 'Occupancy unavailable',
    NOT_BOARDABLE: 'Not boardable'
  };
  const value = String(status);
  return labels[value] ?? value.toLowerCase().split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
