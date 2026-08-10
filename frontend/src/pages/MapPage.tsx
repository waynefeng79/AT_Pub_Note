import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import maplibregl from 'maplibre-gl';
import {
  AlertTriangle,
  ChevronRight,
  Crosshair,
  Heart,
  LocateFixed,
  Lock,
  LogOut,
  RadioTower,
  Route,
  Search,
  Star,
  UserRound,
  Unlock,
  X
} from 'lucide-react';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import {
  activeFeed,
  addFavourite,
  allRoutes,
  alerts,
  favouriteRoutes,
  nearbyStops,
  removeFavourite,
  routeShapes,
  routeStops,
  routeTrips,
  routesOnStops,
  streamRealtime,
  tripShape,
  tripStops,
  tripUpdates,
  vehicles
} from '../api/client';
import type { Session } from '../auth/session';
import type {
  AlertItem,
  DepartureItem,
  FeedResponse,
  JourneyOption,
  TransitJourneyLeg,
  RouteDirection,
  RouteItem,
  RouteShape,
  RealtimeTimeEvent,
  StopItem,
  TripUpdateItem,
  VehicleItem
} from '../types/domain';
import { RouteModeIcon } from '../components/RouteModeIcon';
import {
  dedupeVehicleItems,
  findMatchingVehicle,
  formatOccupancyStatus,
  plannedRouteState,
  presentationCoordinates,
  retainedRouteIds,
  transitLegs,
  toggleLockedRouteIds,
  vehicleIdentityKey,
  vehicleLabel,
  type JourneyMapPresentation,
  type JourneyRealtime
} from '../components/transitMapModel';
import { isExpiredFeedError, loadJourneyPresentation, loadJourneyRealtime, loadStopTransitDetail } from '../components/transitData';
import { createTransitMap, observeTransitMapReady } from '../components/transitMapRuntime';
import { ViewTabs } from '../components/ViewTabs';
import { ensureVehicleImage, routeColour as colour, vehicleFeatures } from '../components/transitMapSymbols';
import {
  JourneyPlannerControls,
  type JourneyPlanSelection
} from '../components/JourneyPlannerControls';

type Props = {
  session: Session;
  onLogout: () => void;
  controlMode: 'map' | 'journey';
  onControlModeChange?: (mode: 'map' | 'journey') => void;
};

type ActiveJourney = {
  selection: JourneyPlanSelection;
  presentation: JourneyMapPresentation;
  realtime: JourneyRealtime;
  partialErrors: string[];
};

type SelectedMapItem =
  | { type: 'route'; item: RouteItem }
  | { type: 'stop'; item: StopItem; source: 'route' | 'nearby' | 'map' }
  | { type: 'vehicle'; item: VehicleItem }
  | { type: 'alerts'; items: AlertItem[] }
  | { type: 'nearby'; items: StopItem[] }
  | { type: 'journey' };

type StopDetailSource = Extract<SelectedMapItem, { type: 'stop' }>['source'];
type RouteModeFilter = 'all' | 'other' | number;
type UiLanguage = 'en' | 'mi';
type UiText = Record<string, string>;
type StopSchedule = {
  stopId: string;
  loading: boolean;
  departures: DepartureItem[];
  updates: Map<string, TripUpdateItem>;
  vehicles: Map<string, VehicleItem>;
  serviceDate?: string;
};

type StopRouteFilter = {
  stop: StopItem;
  routeIds: string[];
  selectedRouteId?: string;
  selectedDirectionId?: number | null;
};

type PendingRouteFocus =
  | { type: 'route'; routeId: string; directionId?: number | null; tripId?: string | null }
  | { type: 'vehicle'; routeId: string; directionId?: number | null; vehicle: VehicleItem };

type TripPattern = {
  tripId: string;
  shape: RouteShape | null;
  direction: RouteDirection | null;
};

type RouteShapeRenderItem = RouteShape & {
  line_color: string;
};

type RouteStopRenderItem = StopItem & {
  line_color?: string;
};

type RouteShapeRenderPlan = {
  shapes: RouteShapeRenderItem[];
  colourByGeometry: Map<string, string>;
  trunkGeometryKey?: string;
};

type RouteMapView =
  | {
      type: 'direction';
      routeId: string;
      directionId: number | null;
      tripIds?: string[];
      shapeColours?: Map<string, string>;
      trunkGeometryKey?: string;
    }
  | {
      type: 'trip';
      routeId: string;
      directionId?: number | null;
      tripId: string;
      shapeColours?: Map<string, string>;
      trunkGeometryKey?: string;
    };

type MonitoredRouteData = {
  route: RouteItem;
  directionId: number | null;
  shapes: RouteShapeRenderItem[];
  stops: RouteStopRenderItem[];
};

type FocusedTripMapData = {
  routeId: string;
  tripId: string;
  shapes: RouteShapeRenderItem[];
  stops: RouteStopRenderItem[];
};

const AUCKLAND: [number, number] = [174.7633, -36.8485];
const SELECTED_ROUTE_STORAGE_KEY = 'at-public-note:selected-route-id';
const STOP_SELECTED_ROUTE_ONLY_STORAGE_KEY = 'at-public-note:stop-selected-route-only';
const STOP_TIMETABLE_BATCH_SIZE = 8;
const MAX_LOCKED_ROUTES = 5;
const MAIN_ROUTE_TYPES = new Set([2, 3, 4]);
const routeModeOptions: { value: RouteModeFilter; label: string; iconType: number }[] = [
  { value: 'all', label: 'All', iconType: 3 },
  { value: 3, label: 'Bus', iconType: 3 },
  { value: 2, label: 'Train', iconType: 2 },
  { value: 4, label: 'Ferry', iconType: 4 },
  { value: 'other', label: 'Other', iconType: 3 }
];
const UI_TEXT = {
  en: {
    languageName: 'English',
    otherLanguageName: 'Te reo Maori',
    routeSearch: 'Route search',
    chooseRoute: 'Choose a route',
    searchRoute: 'Search route',
    matches: 'matches',
    match: 'match',
    stop: 'Stop',
    stops: 'stops',
    vehicles: 'vehicles',
    alerts: 'alerts',
    serviceAlert: 'service alert',
    serviceAlerts: 'service alerts',
    useLiveLocation: 'Use my live location',
    signedInAs: 'Signed in as',
    logout: 'Logout',
    vehicleTypeFilter: 'Vehicle type filter',
    favourites: 'Favourites',
    noSavedRoutes: 'No saved routes',
    activeRoutes: 'Active routes',
    lockRoute: 'Lock selected route',
    unlockRoute: 'Unlock selected route',
    maxLockedRoutes: 'Maximum of 5 locked routes',
    addToActiveRoutes: 'Monitor route',
    removeFromActiveRoutes: 'Stop monitoring route',
    removeFromFavourites: 'Remove from favourites',
    addToFavourites: 'Add to favourites',
    noMatchingRoutes: 'No matching routes.',
    selectedRoute: 'Selected route',
    loadingRoute: 'Loading route',
    routeDirection: 'Route direction',
    directionUnavailable: 'Direction unavailable',
    mode: 'Mode',
    route: 'Route',
    trip: 'Trip',
    service: 'Service',
    scheduledService: 'Scheduled',
    extraService: 'Extra service',
    replacementService: 'Replacement service',
    duplicatedService: 'Duplicated service',
    status: 'Status',
    updated: 'Updated',
    speed: 'Speed',
    occupancy: 'Occupancy',
    platform: 'Platform',
    selectedRouteOnly: 'Selected route only',
    upcomingTimetable: 'Upcoming vehicle timetable',
    loadingUpcoming: 'Loading upcoming vehicles...',
    noUpcoming: 'No upcoming vehicles found.',
    noUpcomingSelectedRouteOnly: 'No upcoming vehicles for the selected route. Untick selected route only to see other routes at this stop.',
    realtimeVehicle: 'Realtime vehicle',
    noLicensePlate: 'No license plate',
    serviceAlertsTitle: 'Service alerts',
    warning: 'warning',
    warnings: 'warnings',
    currentRouteNotices: 'Current route notices',
    noCurrentRouteNotices: 'No current route notices',
    noCurrentAlerts: 'No current alerts for this route.',
    noExtraDetail: 'No extra detail available.',
    nearbyStops: 'Nearby stops',
    useLiveLocationForNearby: 'Use live location to find nearby stops.',
    routeStop: 'Route stop',
    nearbyStop: 'Nearby stop',
    mapStop: 'Map stop',
    networkTitle: 'Auckland transport network',
    all: 'All',
    bus: 'Bus',
    train: 'Train',
    ferry: 'Ferry',
    other: 'Other',
    onTime: 'on time',
    due: 'due',
    minuteSuffix: 'min'
  },
  mi: {
    languageName: 'Te reo Maori',
    otherLanguageName: 'English',
    routeSearch: 'Rapu ararere',
    chooseRoute: 'Kōwhiria he ararere',
    searchRoute: 'Rapua ararere',
    matches: 'ngā ōritenga',
    match: 'ōritenga',
    stop: 'Tūnga',
    stops: 'ngā tūnga',
    vehicles: 'ngā waka',
    alerts: 'ngā whakatūpato',
    serviceAlert: 'whakatūpato ratonga',
    serviceAlerts: 'ngā whakatūpato ratonga',
    useLiveLocation: 'Whakamahia taku tauwāhi ora',
    signedInAs: 'Kua takiuru hei',
    logout: 'Takiputa',
    vehicleTypeFilter: 'Tātari momo waka',
    favourites: 'Ngā makau',
    noSavedRoutes: 'Kāore he ararere kua tiakina',
    activeRoutes: 'Ngā ararere hohe',
    lockRoute: 'Maukati te ararere kua tīpakohia',
    unlockRoute: 'Wewete i te ararere kua tīpakohia',
    maxLockedRoutes: 'E 5 anake ngā ararere ka taea te maukati',
    addToActiveRoutes: 'Aroturuki ararere',
    removeFromActiveRoutes: 'Kati te aroturuki ararere',
    removeFromFavourites: 'Tangohia i ngā makau',
    addToFavourites: 'Tāpiri ki ngā makau',
    noMatchingRoutes: 'Kāore he ararere ōrite.',
    selectedRoute: 'Ararere kua tīpakohia',
    loadingRoute: 'E uta ana te ararere',
    routeDirection: 'Ahunga ararere',
    directionUnavailable: 'Kāore te ahunga i te wātea',
    mode: 'Momo',
    route: 'Ararere',
    trip: 'Haerenga',
    service: 'Ratonga',
    scheduledService: 'Kua whakaritea',
    extraService: 'Ratonga tāpiri',
    replacementService: 'Ratonga whakakapi',
    duplicatedService: 'Ratonga tārua',
    status: 'Tūnga',
    updated: 'Kua whakahōu',
    speed: 'Tere',
    occupancy: 'Kikī',
    platform: 'Papa tū',
    selectedRouteOnly: 'Ko te ararere tīpakohia anake',
    upcomingTimetable: 'Wātaka waka e haere mai ana',
    loadingUpcoming: 'E uta ana ngā waka e haere mai ana...',
    noUpcoming: 'Kāore he waka e haere mai ana.',
    noUpcomingSelectedRouteOnly: 'Kāore he waka mō te ararere kua tīpakohia. Tangohia te tīpako ararere anake kia kite i ētahi atu ararere i tēnei tūnga.',
    realtimeVehicle: 'Waka wā-tūturu',
    noLicensePlate: 'Kāore he nama pereti',
    serviceAlertsTitle: 'Ngā whakatūpato ratonga',
    warning: 'whakatūpato',
    warnings: 'ngā whakatūpato',
    currentRouteNotices: 'Ngā pānui ararere o nāianei',
    noCurrentRouteNotices: 'Kāore he pānui ararere o nāianei',
    noCurrentAlerts: 'Kāore he whakatūpato mō tēnei ararere.',
    noExtraDetail: 'Kāore he kōrero anō.',
    nearbyStops: 'Ngā tūnga tata',
    useLiveLocationForNearby: 'Whakamahia te tauwāhi ora kia kitea ngā tūnga tata.',
    routeStop: 'Tūnga ararere',
    nearbyStop: 'Tūnga tata',
    mapStop: 'Tūnga mahere',
    networkTitle: 'Whatunga waka tūmatanui o Tāmaki Makaurau',
    all: 'Katoa',
    bus: 'Pahi',
    train: 'Tereina',
    ferry: 'Waka whakawhiti',
    other: 'Ētahi atu',
    onTime: 'i te wā tika',
    due: 'kua tae',
    minuteSuffix: 'min'
  }
} as const;
const BRANCH_COLOURS = ['#2563eb', '#dc2626', '#7c3aed', '#ca8a04', '#0891b2', '#be185d'];

function branchColour(route: RouteItem, index: number) {
  if (index === 0) return colour(route);
  return BRANCH_COLOURS[index % BRANCH_COLOURS.length];
}

function stableStringIndex(value: string, modulo: number) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % modulo;
}

function shapeGeometryKey(shape: RouteShape) {
  const coordinates = shape.geometry.coordinates;
  return coordinates
    .map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`)
    .join('|');
}

function vehicleMatchesRouteView(vehicle: VehicleItem, view: RouteMapView | null, route: RouteItem) {
  if (!view || view.routeId !== route.route_id) return false;
  if (view.type === 'trip') return vehicle.trip_id === view.tripId;
  return vehicle.route_id === view.routeId
    && (view.directionId == null || vehicle.direction_id == null || vehicle.direction_id === view.directionId);
}

function coordinateKey([lon, lat]: number[]) {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

function segmentKey(start: number[], end: number[]) {
  const a = coordinateKey(start);
  const b = coordinateKey(end);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function shapeSegmentKeys(shape: RouteShape) {
  const keys = new Set<string>();
  const coordinates = shape.geometry.coordinates;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    keys.add(segmentKey(coordinates[index], coordinates[index + 1]));
  }
  return keys;
}

function shapeOverlapScore(shape: RouteShape, otherShapes: RouteShape[]) {
  const keys = shapeSegmentKeys(shape);
  let score = 0;
  for (const otherShape of otherShapes) {
    if (otherShape === shape) continue;
    const otherKeys = shapeSegmentKeys(otherShape);
    for (const key of keys) {
      if (otherKeys.has(key)) score += 1;
    }
  }
  return score;
}

function chooseTrunkShape(shapes: RouteShape[]) {
  return [...shapes].sort((a, b) => {
    const overlapDiff = shapeOverlapScore(b, shapes) - shapeOverlapScore(a, shapes);
    if (overlapDiff !== 0) return overlapDiff;
    const lengthDiff = b.geometry.coordinates.length - a.geometry.coordinates.length;
    if (lengthDiff !== 0) return lengthDiff;
    return shapeGeometryKey(a).localeCompare(shapeGeometryKey(b));
  })[0] ?? null;
}

function branchColourForGeometry(key: string) {
  return BRANCH_COLOURS[stableStringIndex(key, BRANCH_COLOURS.length)];
}

function uniqueShapes(shapes: RouteShape[]) {
  const byGeometry = new Map<string, RouteShape>();
  for (const shape of shapes) {
    const key = shapeGeometryKey(shape);
    if (!byGeometry.has(key)) byGeometry.set(key, shape);
  }
  return Array.from(byGeometry.values());
}

function additionalBranchShapes(shape: RouteShape, trunkSegments: Set<string>, lineColor: string) {
  const items: RouteShapeRenderItem[] = [];
  const coordinates = shape.geometry.coordinates;
  let segmentCoordinates: number[][] = [];

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const current = coordinates[index];
    const next = coordinates[index + 1];
    const overlapsTrunk = trunkSegments.has(segmentKey(current, next));
    if (overlapsTrunk) {
      if (segmentCoordinates.length > 1) {
        items.push({
          ...shape,
          shape_id: `${shape.shape_id || shapeGeometryKey(shape)}:${items.length}`,
          geometry: { type: 'LineString', coordinates: segmentCoordinates },
          line_color: lineColor
        });
      }
      segmentCoordinates = [];
      continue;
    }

    if (segmentCoordinates.length === 0) segmentCoordinates = [current, next];
    else segmentCoordinates.push(next);
  }

  if (segmentCoordinates.length > 1) {
    items.push({
      ...shape,
      shape_id: `${shape.shape_id || shapeGeometryKey(shape)}:${items.length}`,
      geometry: { type: 'LineString', coordinates: segmentCoordinates },
      line_color: lineColor
    });
  }

  return items;
}

function routeShapeRenderPlan(
  route: RouteItem,
  patterns: TripPattern[],
  fallback: RouteShape[] = [],
  preferredTrunkGeometryKey?: string,
  existingColours?: Map<string, string>
): RouteShapeRenderPlan {
  const liveShapes = uniqueShapes(patterns.map((pattern) => pattern.shape).filter((shape): shape is RouteShape => Boolean(shape)));
  const source = liveShapes.length > 0 ? liveShapes : uniqueShapes(fallback);
  const preferredTrunk = preferredTrunkGeometryKey
    ? source.find((shape) => shapeGeometryKey(shape) === preferredTrunkGeometryKey) ?? null
    : null;
  const trunk = preferredTrunk ?? chooseTrunkShape(source);
  if (!trunk) return { shapes: [], colourByGeometry: new Map() };

  const trunkKey = shapeGeometryKey(trunk);
  const trunkSegments = shapeSegmentKeys(trunk);
  const colourByGeometry = new Map<string, string>();
  const shapes: RouteShapeRenderItem[] = [{ ...trunk, line_color: colour(route) }];
  colourByGeometry.set(trunkKey, colour(route));

  for (const shape of source) {
    const key = shapeGeometryKey(shape);
    if (key === trunkKey) continue;
    const lineColor = existingColours?.get(key) ?? branchColourForGeometry(key);
    colourByGeometry.set(key, lineColor);
    shapes.push(...additionalBranchShapes(shape, trunkSegments, lineColor));
  }

  return { shapes, colourByGeometry, trunkGeometryKey: trunkKey };
}

function focusedTripShapeRenderPlan(
  route: RouteItem,
  patterns: TripPattern[],
  fallback: RouteShape[] = [],
  shapeColours?: Map<string, string>
): RouteShapeRenderPlan {
  const source = uniqueShapes(patterns.map((pattern) => pattern.shape).filter((shape): shape is RouteShape => Boolean(shape)));
  const fallbackShapes = uniqueShapes(fallback);
  const shape = source[0] ?? fallbackShapes[0] ?? null;
  if (!shape) return { shapes: [], colourByGeometry: shapeColours ?? new Map() };
  const key = shapeGeometryKey(shape);
  const isRouteGeometry = fallbackShapes.some((fallbackShape) => shapeGeometryKey(fallbackShape) === key);
  const lineColor = isRouteGeometry ? colour(route) : shapeColours?.get(key) ?? branchColourForGeometry(key);
  const colourByGeometry = new Map(shapeColours ?? []);
  colourByGeometry.set(key, lineColor);
  return { shapes: [{ ...shape, line_color: lineColor }], colourByGeometry };
}

function routeLabel(route: RouteItem) {
  const shortName = route.route_short_name?.trim();
  const longName = route.route_long_name?.trim();
  if (!shortName) return longName || route.route_id;
  if (!longName) return shortName;

  const shortLower = shortName.toLowerCase();
  const longLower = longName.toLowerCase();
  if (longLower === shortLower) return shortName;
  if (longLower.startsWith(`${shortLower} `)) return `${shortName} ${longName.slice(shortName.length).trim()}`;
  return `${shortName} ${longName}`;
}

function matchesRouteMode(route: RouteItem, filter: RouteModeFilter) {
  if (filter === 'all') return true;
  if (filter === 'other') return !MAIN_ROUTE_TYPES.has(route.route_type);
  return route.route_type === filter;
}

function activeTripIds(vehicles: VehicleItem[], updates: TripUpdateItem[]) {
  const ids = new Set<string>();
  for (const vehicle of vehicles) {
    if (vehicle.trip_id) ids.add(vehicle.trip_id);
  }
  for (const update of updates) {
    if (update.trip_id) ids.add(update.trip_id);
  }
  return Array.from(ids).slice(0, 24);
}

function uniqueTripIds(...groups: string[][]) {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const tripId of group) {
      if (tripId) ids.add(tripId);
    }
  }
  return Array.from(ids).slice(0, 24);
}

function mergeByKey<T>(items: T[], keyForItem: (item: T) => string) {
  return Array.from(new Map(items.map((item) => [keyForItem(item), item])).values());
}

function alertIdentityKey(alert: AlertItem) {
  return [
    alert.alert_id,
    alert.header,
    alert.description,
    alert.cause,
    alert.effect,
    (alert.route_ids ?? []).join(',')
  ].join('|');
}

function stopsFromPatterns(
  patterns: TripPattern[],
  fallback: StopItem[] = [],
  shapeColours?: Map<string, string>,
  fallbackColour?: string
) {
  const byStopId = new Map<string, RouteStopRenderItem>();
  for (const pattern of patterns) {
    const lineColor = pattern.shape ? shapeColours?.get(shapeGeometryKey(pattern.shape)) : undefined;
    for (const stop of pattern.direction?.stops ?? []) {
      if (!byStopId.has(stop.stop_id)) byStopId.set(stop.stop_id, { ...stop, line_color: lineColor ?? fallbackColour });
    }
  }
  if (byStopId.size === 0) {
    for (const stop of fallback) {
      if (!byStopId.has(stop.stop_id)) byStopId.set(stop.stop_id, { ...stop, line_color: fallbackColour });
    }
  }
  return Array.from(byStopId.values());
}

function offsetCoincidentStops(stops: StopItem[]) {
  const groups = new Map<string, StopItem[]>();
  for (const stop of stops) {
    const key = `${stop.stop_lon.toFixed(6)},${stop.stop_lat.toFixed(6)}`;
    groups.set(key, [...(groups.get(key) ?? []), stop]);
  }

  const offsets = new Map<string, [number, number]>();
  const offsetMetres = 7;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const orderedStops = [...group].sort((a, b) => {
      const platformDiff = String(a.platform_code ?? '').localeCompare(String(b.platform_code ?? ''), undefined, { numeric: true });
      if (platformDiff !== 0) return platformDiff;
      return a.stop_id.localeCompare(b.stop_id);
    });
    const step = (Math.PI * 2) / orderedStops.length;
    orderedStops.forEach((stop, index) => {
      const angle = index * step - Math.PI / 2;
      const latOffset = (Math.sin(angle) * offsetMetres) / 111_320;
      const lonOffset = (Math.cos(angle) * offsetMetres) / (111_320 * Math.cos((stop.stop_lat * Math.PI) / 180));
      offsets.set(stop.stop_id, [stop.stop_lon + lonOffset, stop.stop_lat + latOffset]);
    });
  }

  return offsets;
}

function formatRealtimeEpoch(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function delayLabel(delaySeconds: number | null, t: UiText = UI_TEXT.en) {
  if (delaySeconds == null || delaySeconds === 0) return t.onTime;
  const minutes = Math.round(Math.abs(delaySeconds) / 60);
  return delaySeconds > 0 ? `+${minutes} ${t.minuteSuffix}` : `-${minutes} ${t.minuteSuffix}`;
}

function storedSelectedRouteId() {
  try {
    return window.localStorage.getItem(SELECTED_ROUTE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberSelectedRoute(route: RouteItem | null) {
  try {
    if (route) window.localStorage.setItem(SELECTED_ROUTE_STORAGE_KEY, route.route_id);
    else window.localStorage.removeItem(SELECTED_ROUTE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing or restricted embeds.
  }
}

function storedStopSelectedRouteOnly() {
  try {
    const savedValue = window.localStorage.getItem(STOP_SELECTED_ROUTE_ONLY_STORAGE_KEY);
    return savedValue == null ? true : savedValue === 'true';
  } catch {
    return true;
  }
}

function rememberStopSelectedRouteOnly(value: boolean) {
  try {
    window.localStorage.setItem(STOP_SELECTED_ROUTE_ONLY_STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable in private browsing or restricted embeds.
  }
}

export function MapPage({ session, onLogout, controlMode, onControlModeChange }: Props) {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const feedRefreshInFlight = useRef(false);
  const routeSelectionLoaded = useRef(false);
  const routeRequestId = useRef(0);
  const stopScheduleRequestId = useRef(0);
  const feedRef = useRef<FeedResponse | null>(null);
  const selectedRouteRef = useRef<RouteItem | null>(null);
  const activeRouteIdsRef = useRef<string[]>([]);
  const lockedRouteIdsRef = useRef<string[]>([]);
  const activeRouteDirectionsRef = useRef<Record<string, number | null>>({});
  const monitoredRouteDataRef = useRef(new Map<string, MonitoredRouteData>());
  const selectedDirectionIdRef = useRef<number | null>(null);
  const selectedMapItemRef = useRef<SelectedMapItem | null>(null);
  const selectedStopHighlightRef = useRef<StopItem | null>(null);
  const stopPanelSelectedRouteOnlyRef = useRef(storedStopSelectedRouteOnly());
  const stopRouteFilterRef = useRef<StopRouteFilter | null>(null);
  const routeItemsRef = useRef<RouteItem[]>([]);
  const stopsRef = useRef<StopItem[]>([]);
  const mapStopsRef = useRef<StopItem[]>([]);
  const vehicleItemsRef = useRef<VehicleItem[]>([]);
  const pendingRouteFocusRef = useRef<PendingRouteFocus | null>(null);
  const tripFocusRequestId = useRef(0);
  const focusedTripMapDataRef = useRef<FocusedTripMapData | null>(null);
  const routeMapViewRef = useRef<RouteMapView | null>(null);
  const activeJourneyRef = useRef<ActiveJourney | null>(null);
  const journeySelectionRequest = useRef(0);
  const startupLocateStarted = useRef(false);
  const mapBackgroundClickBound = useRef(false);
  const userMarker = useRef<maplibregl.Marker | null>(null);
  const locationWatchId = useRef<number | null>(null);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [routeItems, setRouteItems] = useState<RouteItem[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteItem | null>(null);
  const [activeRouteIds, setActiveRouteIds] = useState<string[]>([]);
  const [lockedRouteIds, setLockedRouteIds] = useState<string[]>([]);
  const [activeRouteDirections, setActiveRouteDirections] = useState<Record<string, number | null>>({});
  const [query, setQuery] = useState('');
  const [routeModeFilter, setRouteModeFilter] = useState<RouteModeFilter>('all');
  const [language, setLanguage] = useState<UiLanguage>('en');
  const [routeShapesData, setRouteShapesData] = useState<RouteShape[]>([]);
  const [routeDirections, setRouteDirections] = useState<RouteDirection[]>([]);
  const [selectedDirectionIndex, setSelectedDirectionIndex] = useState(0);
  const [stops, setStops] = useState<StopItem[]>([]);
  const [nearby, setNearby] = useState<StopItem[]>([]);
  const [vehicleItems, setVehicleItems] = useState<VehicleItem[]>([]);
  const [alertItems, setAlertItems] = useState<AlertItem[]>([]);
  const [tripUpdateItems, setTripUpdateItems] = useState<TripUpdateItem[]>([]);
  const [selectedMapItem, setSelectedMapItem] = useState<SelectedMapItem | null>(null);
  const [selectedStopHighlight, setSelectedStopHighlight] = useState<StopItem | null>(null);
  const [selectedVehicleHighlight, setSelectedVehicleHighlight] = useState<VehicleItem | null>(null);
  const [stopSchedule, setStopSchedule] = useState<StopSchedule | null>(null);
  const [stopPanelSelectedRouteOnly, setStopPanelSelectedRouteOnly] = useState(storedStopSelectedRouteOnly);
  const [stopRouteFilter, setStopRouteFilter] = useState<StopRouteFilter | null>(null);
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [favourites, setFavourites] = useState<string[]>([]);
  const [message, setMessage] = useState('Loading active feed');
  const [cacheStatus, setCacheStatus] = useState('ready');
  const [busy, setBusy] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [sseReconnectToken, setSseReconnectToken] = useState(0);
  const [activeJourney, setActiveJourney] = useState<ActiveJourney | null>(null);
  const [journeyOptions, setJourneyOptions] = useState<JourneyPlanSelection[]>([]);

  feedRef.current = feed;
  selectedRouteRef.current = selectedRoute;
  activeRouteIdsRef.current = activeRouteIds;
  lockedRouteIdsRef.current = lockedRouteIds;
  activeRouteDirectionsRef.current = activeRouteDirections;
  selectedDirectionIdRef.current = routeDirections[selectedDirectionIndex]?.direction_id ?? null;
  selectedMapItemRef.current = selectedMapItem;
  selectedStopHighlightRef.current = selectedStopHighlight;
  stopPanelSelectedRouteOnlyRef.current = stopPanelSelectedRouteOnly;
  stopRouteFilterRef.current = stopRouteFilter;
  routeItemsRef.current = routeItems;
  stopsRef.current = stops;
  activeJourneyRef.current = activeJourney;

  const visibleRoutes = useMemo(() => {
    const stopFilteredRoutes = stopRouteFilter
      ? routeItems.filter((route) => stopRouteFilter.routeIds.includes(route.route_id))
      : routeItems;
    const modeFilteredRoutes = stopFilteredRoutes.filter((route) => matchesRouteMode(route, routeModeFilter));
    const needle = query.trim().toLowerCase();
    if (!needle) return modeFilteredRoutes;
    return modeFilteredRoutes.filter((route) => routeLabel(route).toLowerCase().includes(needle));
  }, [query, routeItems, routeModeFilter, stopRouteFilter]);

  const favouriteRouteItems = useMemo(
    () => favourites
      .map((routeId) => routeItems.find((route) => route.route_id === routeId))
      .filter((route): route is RouteItem => Boolean(route)),
    [favourites, routeItems]
  );

  const activeRouteItems = useMemo(
    () => activeRouteIds
      .map((routeId) => routeItems.find((route) => route.route_id === routeId))
      .filter((route): route is RouteItem => Boolean(route)),
    [activeRouteIds, routeItems]
  );
  const mapRouteItems = activeRouteItems.length > 0
    ? activeRouteItems
    : selectedRoute
      ? [selectedRoute]
      : [];
  const routeById = useMemo(() => new Map(routeItems.map((route) => [route.route_id, route])), [routeItems]);

  const tripUpdatesByTrip = useMemo(
    () => new Map(tripUpdateItems.map((item) => [item.trip_id, item])),
    [tripUpdateItems]
  );
  const t = UI_TEXT[language];

  useEffect(() => {
    if (!mapNode.current || map.current) return;
    const instance = createTransitMap(mapNode.current);
    const stopObservingReady = observeTransitMapReady(instance, () => setMapReady(true));
    map.current = instance;
    if (!startupLocateStarted.current) {
      startupLocateStarted.current = true;
      void locateNearby({ showBusy: false, flyTo: true, startup: true });
    }
    return () => {
      if (locationWatchId.current != null) navigator.geolocation.clearWatch(locationWatchId.current);
      userMarker.current?.remove();
      userMarker.current = null;
      stopObservingReady();
      instance.remove();
      map.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    if (!mapReady || activeJourney || !selectedRoute || routeShapesData.length === 0) return;
    if (map.current?.getSource('route-shapes')) return;
    const direction = routeDirections[selectedDirectionIndex] ?? null;
    const shapePlan = routeShapeRenderPlan(selectedRoute, [], shapesForDirection(routeShapesData, direction));
    renderMap(selectedRoute, shapePlan.shapes, stops, selectedStopHighlight);
  }, [mapReady, activeJourney?.presentation.id, selectedRoute?.route_id, routeShapesData, routeDirections, selectedDirectionIndex, stops]);

  useEffect(() => {
    if (!mapReady) return;
    renderSelectedStopHighlight(selectedStopHighlight);
  }, [mapReady, selectedStopHighlight?.stop_id]);

  useEffect(() => {
    if (!mapReady) return;
    renderSelectedVehicleHighlight(selectedVehicleHighlight);
  }, [
    mapReady,
    selectedVehicleHighlight?.vehicle_id,
    selectedVehicleHighlight?.trip_id,
    selectedVehicleHighlight?.position.latitude,
    selectedVehicleHighlight?.position.longitude
  ]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadInitial() {
      setBusy(true);
      try {
        const active = await activeFeed(controller.signal);
        setFeed(active);
        const [routeResult, favResult] = await Promise.all([
          allRoutes(active.feed_version, controller.signal),
          favouriteRoutes(controller.signal)
        ]);
        if (controller.signal.aborted) return;
        routeSelectionLoaded.current = true;
        setRouteItems(routeResult.items);
        setFavourites(favResult.route_ids);
        const savedRouteId = storedSelectedRouteId();
        const initialRoute = routeResult.items.find((route) => route.route_id === savedRouteId) ?? routeResult.items[0] ?? null;
        setSelectedRoute(initialRoute);
        setActiveRouteIds(initialRoute ? [initialRoute.route_id] : []);
        setActiveRouteDirections(initialRoute ? { [initialRoute.route_id]: null } : {});
        setMessage(`${routeResult.page.total} routes available`);
      } catch (err) {
        if (isAbortError(err)) return;
        setMessage(err instanceof Error ? err.message : 'Could not load network');
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void loadInitial();
    return () => controller.abort();
  }, [session.email]);

  useEffect(() => {
    if (!feed || activeJourney || !selectedRoute) return;
    const controller = new AbortController();
    const requestId = ++routeRequestId.current;
    void loadRoute(selectedRoute, feed.feed_version, requestId, controller.signal);
    return () => controller.abort();
  }, [feed?.feed_version, activeJourney?.presentation.id, selectedRoute?.route_id]);

  useEffect(() => {
    if (!routeSelectionLoaded.current) return;
    rememberSelectedRoute(selectedRoute);
  }, [selectedRoute?.route_id]);

  useEffect(() => {
    const reconnect = () => {
      setSseReconnectToken((value) => value + 1);
      void refreshActiveFeed();
      void refreshRealtime(false);
    };
    const handleOnline = () => {
      setMessage('Network reconnected; refreshing realtime');
      reconnect();
    };
    const handleOffline = () => {
      setMessage('Network disconnected; realtime paused');
      setBusy(false);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconnect();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!feed || activeJourneyRef.current || !selectedRoute) return;
    const controller = new AbortController();
    let reconnectTimer: number | undefined;
    const routeIds = activeRouteIds.length > 0 ? activeRouteIds : [selectedRoute.route_id];

    const connect = async () => {
      try {
        await streamRealtime(routeIds, (event) => {
          if (event.feed_version === feed.feed_version) {
            void refreshRealtime(false, selectedRoute.route_id, feed.feed_version);
          }
          else void refreshActiveFeed();
        }, controller.signal);
        if (!controller.signal.aborted) reconnectTimer = window.setTimeout(() => void connect(), 2000);
      } catch {
        if (!controller.signal.aborted) reconnectTimer = window.setTimeout(() => void connect(), 2000);
      }
    };

    void connect();
    return () => {
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, [feed?.feed_version, activeJourney?.presentation.id, selectedRoute?.route_id, activeRouteIds.join(','), sseReconnectToken]);

  useEffect(() => {
    if (!feed) return;
    const timer = window.setInterval(() => void refreshActiveFeed(), 60_000);
    return () => window.clearInterval(timer);
  }, [feed?.feed_version]);

  useEffect(() => {
    if (!feed || activeJourney || !selectedRoute || activeRouteIds.length === 0) return;
    void refreshRealtime(false, selectedRoute.route_id, feed.feed_version);
  }, [feed?.feed_version, activeJourney?.presentation.id, selectedRoute?.route_id, activeRouteIds.join(',')]);

  useEffect(() => {
    if (!feed || activeJourney || !selectedRoute || activeRouteIds.length === 0) return;
    const missingRoutes = activeRouteIds
      .filter((routeId) => routeId !== selectedRoute.route_id && !monitoredRouteDataRef.current.has(routeId))
      .map((routeId) => routeItems.find((route) => route.route_id === routeId))
      .filter((route): route is RouteItem => Boolean(route));
    if (missingRoutes.length === 0) {
      renderMonitoredMap({ fitBounds: false });
      return;
    }
    void Promise.all(missingRoutes.map((route) => loadMonitoredRouteData(
      route,
      activeRouteDirectionsRef.current[route.route_id] ?? null
    )));
  }, [feed?.feed_version, activeJourney?.presentation.id, selectedRoute?.route_id, activeRouteIds.join(','), routeItems]);

  useEffect(() => {
    if (!activeJourney) return;
    let disposed = false;
    let controller = new AbortController();
    const refresh = async () => {
      const snapshot = activeJourneyRef.current;
      if (!snapshot) return;
      const requestController = controller;
      try {
        const result = await loadJourneyRealtime(snapshot.selection.option, snapshot.selection.feedVersion, requestController.signal);
        if (disposed || activeJourneyRef.current?.presentation.id !== snapshot.presentation.id) return;
        const next = { ...snapshot, realtime: result };
        activeJourneyRef.current = next;
        setActiveJourney(next);
        commitVehicleItems(result.vehicles);
        setAlertItems(result.alerts);
        setTripUpdateItems(result.tripUpdates);
        window.setTimeout(() => renderMonitoredMap({ fitBounds: false }), 0);
      } catch (error) {
        if (requestController.signal.aborted || disposed) return;
        setMessage(error instanceof Error ? error.message : 'Journey realtime is temporarily unavailable');
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      controller.abort();
      controller = new AbortController();
      void refresh();
    }, 20_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeJourney?.presentation.id]);

  function commitVehicleItems(items: VehicleItem[]) {
    const dedupedItems = dedupeVehicleItems(items);
    vehicleItemsRef.current = dedupedItems;
    setVehicleItems(dedupedItems);
    setSelectedVehicleHighlight((current) => current ? findMatchingVehicle(dedupedItems, current) ?? current : current);
    const selectedVehicle = selectedMapItemRef.current?.type === 'vehicle' ? selectedMapItemRef.current.item : null;
    const updatedSelectedVehicle = selectedVehicle ? findMatchingVehicle(dedupedItems, selectedVehicle) : null;
    if (updatedSelectedVehicle) setSelectedMapItem({ type: 'vehicle', item: updatedSelectedVehicle });
    return dedupedItems;
  }

  function clearJourneyOverlay() {
    const instance = map.current;
    if (!instance) return;
    const emptyPoints: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
    runWhenStyleReady(instance, () => {
      upsertSource(instance, 'planned-journey-endpoints', emptyPoints);
    });
  }

  function clearActiveJourney() {
    journeySelectionRequest.current += 1;
    activeJourneyRef.current = null;
    setActiveJourney(null);
    setJourneyOptions([]);
    clearJourneyOverlay();
  }

  function renderJourneyOverlay(presentation: JourneyMapPresentation, fitBounds: boolean) {
    const instance = map.current;
    if (!instance) return;
    const endpointFeatures: Feature<Point>[] = [
      {
        type: 'Feature',
        properties: { role: 'origin', name: presentation.origin.name },
        geometry: { type: 'Point', coordinates: [presentation.origin.longitude, presentation.origin.latitude] }
      },
      {
        type: 'Feature',
        properties: { role: 'destination', name: presentation.destination.name },
        geometry: { type: 'Point', coordinates: [presentation.destination.longitude, presentation.destination.latitude] }
      }
    ];

    runWhenStyleReady(instance, () => {
      upsertSource(instance, 'planned-journey-endpoints', { type: 'FeatureCollection', features: endpointFeatures });
      if (!instance.getLayer('planned-journey-endpoints')) {
        instance.addLayer({
          id: 'planned-journey-endpoints',
          type: 'circle',
          source: 'planned-journey-endpoints',
          paint: {
            'circle-radius': 9,
            'circle-color': ['match', ['get', 'role'], 'origin', '#087f5b', '#b42318'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3
          }
        });
      }
      if (!fitBounds) return;
      const coordinates = presentationCoordinates(presentation);
      if (!coordinates.length) return;
      const bounds = coordinates.slice(1).reduce(
        (box, coordinate) => box.extend(coordinate),
        new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
      );
      const compact = instance.getContainer().clientWidth <= 720;
      instance.fitBounds(bounds, {
        padding: compact ? { top: 36, bottom: 36, left: 36, right: 36 } : { top: 80, bottom: 80, left: 80, right: 80 },
        maxZoom: 14
      });
    });
  }

  async function applyJourneySelection(selection: JourneyPlanSelection) {
    const requestId = ++journeySelectionRequest.current;
    setBusy(true);
    setMessage('Loading planned journey');
    try {
      const result = await loadJourneyPresentation(
        selection.feedVersion,
        selection.option,
        selection.origin,
        selection.destination
      );
      if (requestId !== journeySelectionRequest.current) return;

      const legs = transitLegs(selection.option);
      const { routeIds, directionByRoute: directions } = plannedRouteState(selection.option);
      const journeyRoutes = routeIds.map((routeId) => {
        const known = routeItemsRef.current.find((route) => route.route_id === routeId);
        if (known) return known;
        const leg = legs.find((item) => item.route_id === routeId)!;
        return {
          route_id: leg.route_id,
          route_short_name: leg.route_short_name,
          route_long_name: leg.route_long_name,
          route_type: leg.route_type,
          route_color: leg.route_color ?? null,
          route_text_color: leg.route_text_color ?? null
        } satisfies RouteItem;
      });
      const firstRoute = journeyRoutes[0];
      if (!firstRoute) throw new Error('The planned journey contains no transit route.');
      const firstRouteDirections = Array.from(new Map(
        result.presentation.transit
          .filter((item) => item.leg.route_id === firstRoute.route_id)
          .map((item) => [
            `${item.leg.direction_id ?? 'unknown'}:${item.leg.trip_id}`,
            {
              direction_id: item.leg.direction_id ?? null,
              representative_trip_id: item.leg.trip_id,
              trip_headsign: item.leg.headsign ?? null,
              stops: item.stops
            }
          ])
      ).values());

      monitoredRouteDataRef.current.clear();
      for (const route of journeyRoutes) {
        const items = result.presentation.transit.filter((item) => item.leg.route_id === route.route_id);
        monitoredRouteDataRef.current.set(route.route_id, {
          route,
          directionId: items[0]?.leg.direction_id ?? null,
          shapes: items.map((item) => ({
            shape_id: item.leg.shape_id || item.leg.trip_id,
            direction_id: item.leg.direction_id ?? null,
            representative_trip_id: item.leg.trip_id,
            trip_headsign: item.leg.headsign ?? null,
            geometry: item.geometry,
            line_color: `#${(item.leg.route_color || '2563eb').replace('#', '')}`
          })),
          stops: items.flatMap((item) => item.stops.map((stop) => ({
            ...stop,
            line_color: `#${(item.leg.route_color || '2563eb').replace('#', '')}`
          })))
        });
      }

      const nextJourney: ActiveJourney = {
        selection,
        presentation: result.presentation,
        realtime: { vehicles: [], tripUpdates: [], alerts: [], generatedAt: null, partialErrors: [] },
        partialErrors: result.partialErrors
      };
      activeJourneyRef.current = nextJourney;
      activeRouteIdsRef.current = routeIds;
      lockedRouteIdsRef.current = routeIds;
      activeRouteDirectionsRef.current = directions;
      selectedRouteRef.current = firstRoute;
      setActiveJourney(nextJourney);
      setActiveRouteIds(routeIds);
      setLockedRouteIds(routeIds);
      setActiveRouteDirections(directions);
      setSelectedRoute(firstRoute);
      setRouteDirections(firstRouteDirections);
      setSelectedDirectionIndex(0);
      setSelectedStopHighlight(null);
      setSelectedVehicleHighlight(null);
      setStopSchedule(null);
      setRoutePickerOpen(false);
      commitVehicleItems([]);
      setAlertItems([]);
      setTripUpdateItems([]);
      const allStops = result.presentation.transit.flatMap((item) => item.stops);
      setStops(allStops);
      routeMapViewRef.current = {
        type: 'direction',
        routeId: firstRoute.route_id,
        directionId: legs[0]?.direction_id ?? null,
        tripIds: legs.map((leg) => leg.trip_id)
      };
      const selectionItem: SelectedMapItem = { type: 'journey' };
      selectedMapItemRef.current = selectionItem;
      setSelectedMapItem(selectionItem);
      const primaryData = monitoredRouteDataRef.current.get(firstRoute.route_id)!;
      renderMap(firstRoute, primaryData.shapes, primaryData.stops, null, { fitBounds: false });
      renderJourneyOverlay(result.presentation, true);
      setMessage(`${routeIds.length} planned route${routeIds.length === 1 ? '' : 's'} locked`);
    } catch (error) {
      if (requestId !== journeySelectionRequest.current) return;
      if (isExpiredFeedError(error)) throw new Error('The timetable data changed. Plan the journey again.');
      throw error;
    } finally {
      if (requestId === journeySelectionRequest.current) setBusy(false);
    }
  }

  async function refreshActiveFeed() {
    if (feedRefreshInFlight.current) return;
    feedRefreshInFlight.current = true;
    try {
      const active = await activeFeed();
      if (active.feed_version === feedRef.current?.feed_version) return;
      const journeyExpired = Boolean(activeJourneyRef.current);
      if (journeyExpired) clearActiveJourney();
      const routeResult = await allRoutes(active.feed_version);
      setFeed(active);
      setRouteItems(routeResult.items);
      const nextSelectedRoute = routeResult.items.find((route) => route.route_id === selectedRouteRef.current?.route_id)
        ?? routeResult.items[0]
        ?? null;
      setSelectedRoute(nextSelectedRoute);
      setActiveRouteIds((current) => {
        const available = new Set(routeResult.items.map((route) => route.route_id));
        const next = current.filter((routeId) => available.has(routeId));
        if (nextSelectedRoute && !next.includes(nextSelectedRoute.route_id)) next.unshift(nextSelectedRoute.route_id);
        return next;
      });
      setActiveRouteDirections((current) => {
        const available = new Set(routeResult.items.map((route) => route.route_id));
        return Object.fromEntries(Object.entries(current).filter(([routeId]) => available.has(routeId)));
      });
      setLockedRouteIds((current) => {
        const available = new Set(routeResult.items.map((route) => route.route_id));
        return current.filter((routeId) => available.has(routeId));
      });
      monitoredRouteDataRef.current.clear();
      commitVehicleItems([]);
      setAlertItems([]);
      setTripUpdateItems([]);
      setSelectedMapItem(null);
      setSelectedStopHighlight(null);
      setSelectedVehicleHighlight(null);
      setStopSchedule(null);
      setStopRouteFilter(null);
      setMessage(journeyExpired
        ? 'Timetable data changed; plan the journey again'
        : `Static feed updated; ${routeResult.page.total} routes available`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not refresh the active feed');
    } finally {
      feedRefreshInFlight.current = false;
    }
  }

  async function loadRoute(route: RouteItem, feedVersion: string, requestId: number, signal: AbortSignal) {
    setBusy(true);
    setMessage(`Loading ${route.route_short_name || route.route_id}`);
    try {
      const [shapeResult, stopResult] = await Promise.all([
        routeShapes(feedVersion, route.route_id, signal),
        routeStops(feedVersion, route.route_id, signal)
      ]);
      if (signal.aborted || requestId !== routeRequestId.current) return;
      const availableDirections = stopResult.directions.filter((direction) => direction.stops.length > 0);
      const pendingFocus = pendingRouteFocusRef.current?.routeId === route.route_id ? pendingRouteFocusRef.current : null;
      const requestedDirectionId = pendingFocus?.directionId;
      const requestedDirectionIndex = requestedDirectionId == null
        ? -1
        : availableDirections.findIndex((direction) => direction.direction_id === requestedDirectionId);
      const primaryDirectionIndex = requestedDirectionIndex >= 0 ? requestedDirectionIndex : 0;
      const primaryDirection = availableDirections[primaryDirectionIndex] ?? null;
      const primaryDirectionId = primaryDirection?.direction_id ?? null;
      const [vehicleResult, alertResult, tripUpdateResult] = await Promise.all([
        vehicles([route.route_id], primaryDirectionId, signal),
        alerts([route.route_id], signal),
        tripUpdates([route.route_id], [], [], primaryDirectionId, signal)
      ]);
      if (signal.aborted || requestId !== routeRequestId.current) return;
      const primaryStops = primaryDirection?.stops ?? [];
      const primaryShapes = shapesForDirection(shapeResult.items, primaryDirection);
      const realtimeMatches = (version: string | null | undefined) => version === feedVersion;
      const preservedActiveVehicles = vehicleItemsRef.current.filter((vehicle) => (
        vehicle.route_id !== route.route_id && activeRouteIdsRef.current.includes(vehicle.route_id)
      ));
      const currentVehicles = dedupeVehicleItems([
        ...preservedActiveVehicles,
        ...(realtimeMatches(vehicleResult.feed_version) ? vehicleResult.items : [])
      ]);
      const currentAlerts = realtimeMatches(alertResult.feed_version) ? alertResult.items.slice(0, 10) : [];
      const currentTripUpdates = realtimeMatches(tripUpdateResult.feed_version) ? tripUpdateResult.items : [];
      const focusedTripId = pendingFocus?.type === 'vehicle' ? pendingFocus.vehicle.trip_id : pendingFocus?.tripId;
      const scheduledTripIds = focusedTripId ? [] : await loadRouteTripIds(route.route_id, primaryDirectionId, signal);
      if (signal.aborted || requestId !== routeRequestId.current) return;
      const realtimeTripIds = activeTripIds(currentVehicles, currentTripUpdates);
      const tripIds = focusedTripId ? [focusedTripId] : uniqueTripIds(scheduledTripIds, realtimeTripIds);
      const tripPatterns = await loadTripPatterns(feedVersion, tripIds, signal);
      if (signal.aborted || requestId !== routeRequestId.current) return;
      const shapePlan = focusedTripId
        ? focusedTripShapeRenderPlan(route, tripPatterns, primaryShapes)
        : routeShapeRenderPlan(route, tripPatterns, primaryShapes);
      const mapStops = stopsFromPatterns(
        tripPatterns,
        focusedTripId ? primaryStops : [],
        shapePlan.colourByGeometry,
        colour(route)
      );
      focusedTripMapDataRef.current = focusedTripId
        ? { routeId: route.route_id, tripId: focusedTripId, shapes: shapePlan.shapes, stops: mapStops }
        : null;
      setRouteShapesData(shapeResult.items);
      setRouteDirections(availableDirections);
      setSelectedDirectionIndex(primaryDirectionIndex);
      stopsRef.current = mapStops;
      setStops(mapStops);
      monitoredRouteDataRef.current.set(route.route_id, {
        route,
        directionId: primaryDirectionId,
        shapes: shapePlan.shapes,
        stops: mapStops
      });
      setActiveRouteDirections((current) => ({ ...current, [route.route_id]: primaryDirectionId }));
      commitVehicleItems(currentVehicles);
      setAlertItems(currentAlerts);
      setTripUpdateItems(currentTripUpdates);
      const highlightedStop = selectedMapItemRef.current?.type === 'stop'
        ? selectedMapItemRef.current.item
        : selectedStopHighlightRef.current;
      const preserveStopSelection = selectedMapItemRef.current?.type === 'stop';
      if (pendingFocus?.type === 'vehicle') {
        setSelectedVehicleHighlight(pendingFocus.vehicle);
        setSelectedStopHighlight(null);
        setSelectedMapItem({ type: 'vehicle', item: pendingFocus.vehicle });
        pendingRouteFocusRef.current = null;
      } else if (pendingFocus?.type === 'route') {
        setSelectedVehicleHighlight(null);
        if (!preserveStopSelection) {
          setSelectedStopHighlight(null);
          setSelectedMapItem({ type: 'route', item: route });
        }
        pendingRouteFocusRef.current = null;
      } else if (!isPortraitViewport() || selectedMapItemRef.current?.type === 'route') {
        setSelectedMapItem({ type: 'route', item: route });
      }
      routeMapViewRef.current = focusedTripId
        ? {
            type: 'trip',
            routeId: route.route_id,
            directionId: primaryDirectionId,
            tripId: focusedTripId,
            shapeColours: shapePlan.colourByGeometry,
            trunkGeometryKey: shapePlan.trunkGeometryKey
          }
        : {
            type: 'direction',
            routeId: route.route_id,
            directionId: primaryDirectionId,
            tripIds: scheduledTripIds,
            shapeColours: shapePlan.colourByGeometry,
            trunkGeometryKey: shapePlan.trunkGeometryKey
          };
      const stopToHighlight = pendingFocus && !preserveStopSelection ? null : highlightedStop;
      setSelectedStopHighlight(stopToHighlight);
      renderMap(route, shapePlan.shapes, mapStops, stopToHighlight);
      setMessage(
        realtimeMatches(vehicleResult.feed_version) && realtimeMatches(alertResult.feed_version)
          ? `${route.route_short_name || route.route_id} loaded`
          : `${route.route_short_name || route.route_id} loaded; waiting for matching realtime data`
      );
    } catch (err) {
      if (isAbortError(err)) return;
      setMessage(err instanceof Error ? err.message : 'Could not load route');
    } finally {
      if (!signal.aborted && requestId === routeRequestId.current) setBusy(false);
    }
  }

  async function loadRouteTripIds(routeId: string, directionId: number | null, signal?: AbortSignal) {
    const expectedFeedVersion = feedRef.current?.feed_version;
    if (!expectedFeedVersion) return [];
    const result = await routeTrips(routeId, directionId, signal);
    if (result.feed_version !== expectedFeedVersion) return [];
    return result.items.map((item) => item.trip_id).filter(Boolean).slice(0, 24);
  }

  async function loadTripPatterns(feedVersion: string, tripIds: string[], signal?: AbortSignal): Promise<TripPattern[]> {
    const uniqueTripIds = Array.from(new Set(tripIds.filter(Boolean))).slice(0, 24);
    const patterns: TripPattern[] = await Promise.all(uniqueTripIds.map(async (tripId): Promise<TripPattern> => {
      try {
        const [shape, direction] = await Promise.all([
          tripShape(feedVersion, tripId, signal),
          tripStops(feedVersion, tripId, signal)
        ]);
        return { tripId, shape, direction };
      } catch {
        return { tripId, shape: null, direction: null };
      }
    }));
    return patterns.filter((pattern) => pattern.shape || (pattern.direction && pattern.direction.stops.length > 0));
  }

  async function loadMonitoredRouteData(route: RouteItem, requestedDirectionId?: number | null) {
    const feedVersion = feedRef.current?.feed_version;
    if (!feedVersion) return;
    try {
      const [shapeResult, stopResult] = await Promise.all([
        routeShapes(feedVersion, route.route_id),
        routeStops(feedVersion, route.route_id)
      ]);
      if (feedRef.current?.feed_version !== feedVersion) return;
      if (
        routeMapViewRef.current?.routeId === route.route_id &&
        routeMapViewRef.current.type === 'trip'
      ) return;
      const directions = stopResult.directions.filter((direction) => direction.stops.length > 0);
      const direction = directions.find((item) => item.direction_id === requestedDirectionId) ?? directions[0] ?? null;
      const directionId = direction?.direction_id ?? null;
      const plan = routeShapeRenderPlan(route, [], shapesForDirection(shapeResult.items, direction));
      const routeData: MonitoredRouteData = {
        route,
        directionId,
        shapes: plan.shapes,
        stops: (direction?.stops ?? []).map((stop) => ({ ...stop, line_color: colour(route) }))
      };
      monitoredRouteDataRef.current.set(route.route_id, routeData);
      setActiveRouteDirections((current) => ({ ...current, [route.route_id]: directionId }));
      renderMonitoredMap();
    } catch {
      // The focused route remains usable if a secondary route cannot load.
    }
  }

  function renderMonitoredMap(options: { fitBounds?: boolean } = { fitBounds: false }) {
    const route = selectedRouteRef.current;
    const data = route ? monitoredRouteDataRef.current.get(route.route_id) : null;
    if (!route || !data) return;
    if (routeMapViewRef.current?.routeId === route.route_id && routeMapViewRef.current.type === 'trip') return;
    renderMap(route, data.shapes, data.stops, selectedStopHighlightRef.current, options);
  }

  function renderMap(
    route: RouteItem,
    shapes: RouteShapeRenderItem[],
    routeStopItems: RouteStopRenderItem[],
    highlightedStop: StopItem | null = selectedStopHighlight,
    options: { fitBounds?: boolean } = {}
  ) {
    const instance = map.current;
    if (!instance) return;

    const paintRoute = () => {
      if (selectedRouteRef.current?.route_id !== route.route_id) return;
      const activeView = routeMapViewRef.current;
      const focusedTrip = activeView?.type === 'trip' && activeView.routeId === route.route_id
        ? focusedTripMapDataRef.current?.routeId === route.route_id && focusedTripMapDataRef.current.tripId === activeView.tripId
          ? focusedTripMapDataRef.current
          : null
        : null;
      if (activeView?.type === 'trip' && activeView.routeId === route.route_id && !focusedTrip) return;
      const effectiveShapes = focusedTrip?.shapes ?? shapes;
      const effectiveStops = focusedTrip?.stops ?? routeStopItems;
      const monitoredEntries = activeRouteIdsRef.current
        .map((routeId) => monitoredRouteDataRef.current.get(routeId))
        .filter((item): item is MonitoredRouteData => Boolean(item));
      const selectedEntry: MonitoredRouteData = {
        route,
        directionId: activeRouteDirectionsRef.current[route.route_id] ?? null,
        shapes: effectiveShapes,
        stops: effectiveStops
      };
      const entries = monitoredEntries.some((item) => item.route.route_id === route.route_id)
        ? monitoredEntries.map((item) => item.route.route_id === route.route_id ? selectedEntry : item)
        : [selectedEntry, ...monitoredEntries];
      const shapeFeatures: Feature<LineString>[] = entries.flatMap((entry) => entry.shapes.map((shape, index) => ({
        type: 'Feature',
        properties: {
          route_id: entry.route.route_id,
          selected_route: entry.route.route_id === route.route_id,
          shape_id: shape.shape_id,
          trip_id: shape.representative_trip_id ?? '',
          line_color: shape.line_color ?? branchColour(entry.route, index)
        },
        geometry: shape.geometry
      })));
      const allStops = entries.flatMap((entry) => entry.stops);
      mapStopsRef.current = allStops;
      stopsRef.current = allStops;
      const stopOffsets = offsetCoincidentStops(allStops);
      const stopFeatures: Feature<Point>[] = entries.flatMap((entry) => entry.stops.map((stop) => ({
        type: 'Feature',
        properties: { route_id: entry.route.route_id, stop_id: stop.stop_id, name: stop.stop_name },
        geometry: { type: 'Point', coordinates: stopOffsets.get(stop.stop_id) ?? [stop.stop_lon, stop.stop_lat] }
      })));
      const stopConnectorFeatures: Feature<LineString>[] = [];
      for (const entry of entries) for (const stop of entry.stops) {
        const offset = stopOffsets.get(stop.stop_id);
        if (!offset) continue;
        stopConnectorFeatures.push({
          type: 'Feature',
          properties: { route_id: entry.route.route_id, stop_id: stop.stop_id, line_color: stop.line_color ?? colour(entry.route) },
          geometry: {
            type: 'LineString',
            coordinates: [[stop.stop_lon, stop.stop_lat], offset]
          }
        });
      }
      const routeCollection: FeatureCollection<LineString> = { type: 'FeatureCollection', features: shapeFeatures };
      const stopCollection: FeatureCollection<Point> = { type: 'FeatureCollection', features: stopFeatures };
      const stopConnectorCollection: FeatureCollection<LineString> = { type: 'FeatureCollection', features: stopConnectorFeatures };
      for (const item of routeItemsRef.current) {
        ensureVehicleImage(instance, item);
        ensureVehicleImage(instance, item, true);
      }
      ensureVehicleImage(instance, route);
      ensureVehicleImage(instance, route, true);
      const vehicleCollection: FeatureCollection<Point> = { type: 'FeatureCollection', features: vehicleFeatures(vehicleItemsRef.current, routeById, route) };
      const selectedVehicleCollection: FeatureCollection<Point> = {
        type: 'FeatureCollection',
        features: vehicleFeatures(
          vehicleItemsRef.current.filter((vehicle) => vehicleMatchesRouteView(vehicle, routeMapViewRef.current, route)),
          routeById,
          route
        )
      };

      upsertSource(instance, 'route-shapes', routeCollection);
      upsertSource(instance, 'route-stop-connectors', stopConnectorCollection);
      upsertSource(instance, 'route-stops', stopCollection);
      upsertSource(instance, 'route-vehicles', vehicleCollection);
      upsertSource(instance, 'selected-route-vehicles', selectedVehicleCollection);

      if (!instance.getLayer('route-line')) {
        instance.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route-shapes',
          paint: {
            'line-color': ['get', 'line_color'],
            'line-width': ['case', ['==', ['get', 'selected_route'], true], 6, 4],
            'line-opacity': ['case', ['==', ['get', 'selected_route'], true], 0.96, 0.68]
          }
        });
      } else {
        instance.setPaintProperty('route-line', 'line-color', ['get', 'line_color']);
        instance.setPaintProperty('route-line', 'line-width', ['case', ['==', ['get', 'selected_route'], true], 6, 4]);
        instance.setPaintProperty('route-line', 'line-opacity', ['case', ['==', ['get', 'selected_route'], true], 0.96, 0.68]);
      }

      if (!instance.getLayer('stop-connectors')) {
        instance.addLayer({
          id: 'stop-connectors',
          type: 'line',
          source: 'route-stop-connectors',
          paint: {
            'line-color': ['get', 'line_color'],
            'line-width': 4.5,
            'line-opacity': 0.88
          }
        });
      } else {
        instance.setPaintProperty('stop-connectors', 'line-color', ['get', 'line_color']);
      }

      if (!instance.getLayer('stop-points')) {
        instance.addLayer({
          id: 'stop-points',
          type: 'circle',
          source: 'route-stops',
          paint: {
            'circle-radius': 4.8,
            'circle-color': '#ffffff',
            'circle-stroke-color': '#334155',
            'circle-stroke-width': 1.5
          }
        });
        instance.on('click', 'stop-points', (event) => {
          markMapItemClick(event);
          const feature = event.features?.[0];
          if (!feature || feature.geometry.type !== 'Point') return;
          const stopId = String(feature.properties?.stop_id ?? '');
          const routeId = String(feature.properties?.route_id ?? '');
          const stop = mapStopsRef.current.find((item) => item.stop_id === stopId);
          if (stop) void selectStopAndFilterRoutes(stop, 'map', routeId || undefined);
        });
        instance.on('mouseenter', 'stop-points', () => {
          instance.getCanvas().style.cursor = 'pointer';
        });
        instance.on('mouseleave', 'stop-points', () => {
          instance.getCanvas().style.cursor = '';
        });
      }

      if (!instance.getLayer('vehicle-points')) {
        instance.addLayer({
          id: 'vehicle-points',
          type: 'symbol',
          source: 'route-vehicles',
          layout: {
            'icon-image': ['get', 'mode_image'],
            'icon-size': 1,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true
          }
        });
        const handleVehicleClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          markMapItemClick(event);
          const feature = event.features?.[0];
          if (!feature) return;
          const vehicleKey = String(feature.properties?.vehicle_key ?? '');
          const vehicle = vehicleItemsRef.current.find((item) => vehicleIdentityKey(item) === vehicleKey);
          if (vehicle) selectVehicle(vehicle);
        };
        instance.on('click', 'vehicle-points', handleVehicleClick);
        instance.on('mouseenter', 'vehicle-points', () => {
          instance.getCanvas().style.cursor = 'pointer';
        });
        instance.on('mouseleave', 'vehicle-points', () => {
          instance.getCanvas().style.cursor = '';
        });
      }

      if (!instance.getLayer('selected-route-vehicle-halo')) {
        instance.addLayer({
          id: 'selected-route-vehicle-halo',
          type: 'circle',
          source: 'selected-route-vehicles',
          paint: {
            'circle-radius': 13,
            'circle-color': '#f59e0b',
            'circle-opacity': 0.28,
            'circle-stroke-color': '#92400e',
            'circle-stroke-width': 2
          }
        });
      }

      if (!instance.getLayer('selected-route-vehicle-points')) {
        instance.addLayer({
          id: 'selected-route-vehicle-points',
          type: 'symbol',
          source: 'selected-route-vehicles',
          layout: {
            'icon-image': ['get', 'mode_image'],
            'icon-size': 1.25,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true
          }
        });
        const handleSelectedVehicleClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          markMapItemClick(event);
          const feature = event.features?.[0];
          if (!feature) return;
          const vehicleKey = String(feature.properties?.vehicle_key ?? '');
          const vehicle = vehicleItemsRef.current.find((item) => vehicleIdentityKey(item) === vehicleKey);
          if (vehicle) selectVehicle(vehicle);
        };
        instance.on('click', 'selected-route-vehicle-points', handleSelectedVehicleClick);
        instance.on('mouseenter', 'selected-route-vehicle-points', () => {
          instance.getCanvas().style.cursor = 'pointer';
        });
        instance.on('mouseleave', 'selected-route-vehicle-points', () => {
          instance.getCanvas().style.cursor = '';
        });
      }

      if (!mapBackgroundClickBound.current) {
        mapBackgroundClickBound.current = true;
        instance.on('click', (event) => {
          if (isMapItemClick(event)) return;
          if (isPortraitViewport()) {
            setSelectedMapItem(null);
            setRoutePickerOpen(false);
            setSelectedStopHighlight(null);
            setSelectedVehicleHighlight(null);
            setStopSchedule(null);
            return;
          }
          const route = selectedRouteRef.current;
          if (!route) return;
          setRoutePickerOpen(false);
          setSelectedMapItem({ type: 'route', item: route });
          setSelectedStopHighlight(null);
          setSelectedVehicleHighlight(null);
          setStopSchedule(null);
        });
      }

      renderSelectedStopHighlight(highlightedStop, stopOffsets);

      const coordinates = shapeFeatures.flatMap((shape) => shape.geometry.coordinates);
      if (options.fitBounds !== false && coordinates.length) {
        const bounds = coordinates.reduce(
          (box, coord) => box.extend(coord as [number, number]),
          new maplibregl.LngLatBounds(coordinates[0] as [number, number], coordinates[0] as [number, number])
        );
        const compact = instance.getContainer().clientWidth <= 720;
        const padding = compact
          ? { top: 36, bottom: 36, left: 36, right: 36 }
          : { top: 80, bottom: 80, left: 80, right: 80 };
        instance.fitBounds(bounds, { padding, maxZoom: 14 });
      }
    };

    runWhenStyleReady(instance, paintRoute);
  }

  function renderSelectedStopHighlight(stop: StopItem | null, stopOffsets = offsetCoincidentStops(stopsRef.current)) {
    const instance = map.current;
    if (!instance) return;

    const paintHighlight = () => {
      const stopFeatures: Feature<Point>[] = stop
        ? [{
            type: 'Feature',
            properties: { stop_id: stop.stop_id, name: stop.stop_name },
            geometry: { type: 'Point', coordinates: stopOffsets.get(stop.stop_id) ?? [stop.stop_lon, stop.stop_lat] }
          }]
        : [];
      upsertSource(instance, 'selected-stop-highlight', { type: 'FeatureCollection', features: stopFeatures });

      if (!instance.getLayer('selected-stop-halo')) {
        instance.addLayer({
          id: 'selected-stop-halo',
          type: 'circle',
          source: 'selected-stop-highlight',
          paint: {
            'circle-radius': 13,
            'circle-color': '#facc15',
            'circle-opacity': 0.28,
            'circle-stroke-color': '#ca8a04',
            'circle-stroke-width': 2
          }
        });
      }

      if (!instance.getLayer('selected-stop-dot')) {
        instance.addLayer({
          id: 'selected-stop-dot',
          type: 'circle',
          source: 'selected-stop-highlight',
          paint: {
            'circle-radius': 5.5,
            'circle-color': '#facc15',
            'circle-stroke-color': '#17202a',
            'circle-stroke-width': 1.3
          }
        });
      }
    };

    runWhenStyleReady(instance, paintHighlight);
  }

  function renderSelectedVehicleHighlight(vehicle: VehicleItem | null) {
    const instance = map.current;
    if (!instance) return;

    const paintHighlight = () => {
      const vehicleFeaturesForHighlight: Feature<Point>[] = vehicle?.position.latitude != null && vehicle.position.longitude != null
        ? [{
            type: 'Feature',
            properties: { id: vehicle.vehicle_id, trip_id: vehicle.trip_id },
            geometry: { type: 'Point', coordinates: [vehicle.position.longitude, vehicle.position.latitude] }
          }]
        : [];
      upsertSource(instance, 'selected-vehicle-highlight', { type: 'FeatureCollection', features: vehicleFeaturesForHighlight });

      if (!instance.getLayer('selected-vehicle-halo')) {
        instance.addLayer({
          id: 'selected-vehicle-halo',
          type: 'circle',
          source: 'selected-vehicle-highlight',
          paint: {
            'circle-radius': 16,
            'circle-color': '#f59e0b',
            'circle-opacity': 0.24,
            'circle-stroke-color': '#92400e',
            'circle-stroke-width': 2
          }
        });
      }
    };

    runWhenStyleReady(instance, paintHighlight);
  }

  function renderVehicles(items: VehicleItem[]) {
    const instance = map.current;
    if (!instance?.isStyleLoaded()) return;
    const source = instance.getSource('route-vehicles') as maplibregl.GeoJSONSource | undefined;
    if (source) {
      const lookup = new Map(routeItemsRef.current.map((route) => [route.route_id, route]));
      for (const item of activeRouteIdsRef.current) {
        const route = lookup.get(item);
        if (!route) continue;
        ensureVehicleImage(instance, route);
        ensureVehicleImage(instance, route, true);
      }
      ensureVehicleImage(instance, selectedRouteRef.current);
      ensureVehicleImage(instance, selectedRouteRef.current, true);
      source.setData({ type: 'FeatureCollection', features: vehicleFeatures(items, lookup, selectedRouteRef.current) });
      const selectedSource = instance.getSource('selected-route-vehicles') as maplibregl.GeoJSONSource | undefined;
      const selectedRoute = selectedRouteRef.current;
      if (selectedSource && selectedRoute) {
        selectedSource.setData({
          type: 'FeatureCollection',
          features: vehicleFeatures(
            items.filter((vehicle) => vehicleMatchesRouteView(vehicle, routeMapViewRef.current, selectedRoute)),
            lookup,
            selectedRoute
          )
        });
      }
    }
  }

  function selectDirection(index: number) {
    if (!selectedRoute) return;
    const direction = routeDirections[index];
    if (!direction) return;
    selectedDirectionIdRef.current = direction.direction_id ?? null;
    tripFocusRequestId.current += 1;
    focusedTripMapDataRef.current = null;
    setSelectedDirectionIndex(index);
    setActiveRouteDirections((current) => ({ ...current, [selectedRoute.route_id]: direction.direction_id ?? null }));
    stopsRef.current = [];
    setStops([]);
    commitVehicleItems([]);
    routeMapViewRef.current = { type: 'direction', routeId: selectedRoute.route_id, directionId: direction.direction_id ?? null };
    setSelectedMapItem({ type: 'route', item: selectedRoute });
    setSelectedStopHighlight(null);
    setSelectedVehicleHighlight(null);
    setStopSchedule(null);
    if (feed?.feed_version) void refreshRealtime(true, selectedRoute.route_id, feed.feed_version, direction.direction_id);
    setMessage(`${directionLabel(direction, index)} selected`);
    void loadMonitoredRouteData(selectedRoute, direction.direction_id);
  }

  async function focusTripPattern(
    route: RouteItem,
    tripId: string,
    directionId?: number | null,
    vehicle?: VehicleItem
  ) {
    const feedVersion = feedRef.current?.feed_version;
    if (!feedVersion) return;
    const requestId = ++tripFocusRequestId.current;
    const previousView = routeMapViewRef.current;
    routeMapViewRef.current = {
      type: 'trip',
      routeId: route.route_id,
      directionId,
      tripId,
      shapeColours: previousView?.routeId === route.route_id ? previousView.shapeColours : undefined,
      trunkGeometryKey: previousView?.routeId === route.route_id ? previousView.trunkGeometryKey : undefined
    };
    const patterns = await loadTripPatterns(feedVersion, [tripId]);
    if (
      requestId !== tripFocusRequestId.current ||
      selectedRouteRef.current?.route_id !== route.route_id ||
      feedRef.current?.feed_version !== feedVersion
    ) return;
    const originalShapes = shapesForDirection(routeShapesData, { direction_id: directionId ?? null } as RouteDirection);
    const existingShapeColours = routeMapViewRef.current?.routeId === route.route_id
      ? routeMapViewRef.current.shapeColours
      : undefined;
    const shapePlan = focusedTripShapeRenderPlan(route, patterns, originalShapes, existingShapeColours);
    const stopsForTrip = stopsFromPatterns(patterns, stops, shapePlan.colourByGeometry, colour(route));
    focusedTripMapDataRef.current = {
      routeId: route.route_id,
      tripId,
      shapes: shapePlan.shapes,
      stops: stopsForTrip
    };
    routeMapViewRef.current = {
      type: 'trip',
      routeId: route.route_id,
      directionId,
      tripId,
      shapeColours: shapePlan.colourByGeometry,
      trunkGeometryKey: shapePlan.trunkGeometryKey ?? routeMapViewRef.current?.trunkGeometryKey
    };
    stopsRef.current = stopsForTrip;
    setStops(stopsForTrip);
    if (vehicle) {
      setSelectedVehicleHighlight(vehicle);
      setSelectedStopHighlight(null);
      setSelectedMapItem({ type: 'vehicle', item: vehicle });
    } else {
      setSelectedVehicleHighlight(null);
      setSelectedStopHighlight(null);
      setSelectedMapItem({ type: 'route', item: route });
    }
    setStopSchedule(null);
    renderMap(route, shapePlan.shapes, stopsForTrip, null);
  }

  function selectDirectionForDeparture(departure: DepartureItem) {
    if (departure.direction_id == null) return false;
    const index = routeDirections.findIndex((direction) => direction.direction_id === departure.direction_id);
    if (index < 0) return false;
    if (index !== selectedDirectionIndex) selectDirection(index);
    return true;
  }

  function setJourneyRouteDirections(route: RouteItem, journey: ActiveJourney, directions: RouteDirection[]) {
    const plannedDirectionId = journey.presentation.transit.find((item) => item.leg.route_id === route.route_id)?.leg.direction_id ?? null;
    const selectedIndex = Math.max(0, directions.findIndex((direction) => direction.direction_id === plannedDirectionId));
    setRouteDirections(directions);
    setSelectedDirectionIndex(selectedIndex);
  }

  function loadJourneyRouteDirections(route: RouteItem, journey: ActiveJourney) {
    const fallback = journey.presentation.transit
      .filter((item) => item.leg.route_id === route.route_id)
      .map((item) => ({
        direction_id: item.leg.direction_id ?? null,
        representative_trip_id: item.leg.trip_id,
        trip_headsign: item.leg.headsign ?? null,
        stops: item.stops
      }));
    const fallbackDirections = Array.from(new Map(fallback.map((item) => [item.direction_id, item])).values());
    setJourneyRouteDirections(route, journey, fallbackDirections);
    const presentationId = journey.presentation.id;
    void routeStops(journey.selection.feedVersion, route.route_id).then((result) => {
      if (activeJourneyRef.current?.presentation.id !== presentationId || selectedRouteRef.current?.route_id !== route.route_id) return;
      setJourneyRouteDirections(route, journey, result.directions);
    }).catch(() => {
      // The planned trip's own direction remains available when the route lookup is unavailable.
    });
  }

  function chooseRoute(route: RouteItem) {
    const journey = activeJourneyRef.current;
    if (journey && lockedRouteIdsRef.current.includes(route.route_id)) {
      selectedRouteRef.current = route;
      setSelectedRoute(route);
      const selection: SelectedMapItem = { type: 'route', item: route };
      selectedMapItemRef.current = selection;
      setSelectedMapItem(selection);
      setSelectedStopHighlight(null);
      setSelectedVehicleHighlight(null);
      const plannedLeg = journey.presentation.transit.find((item) => item.leg.route_id === route.route_id)?.leg;
      routeMapViewRef.current = {
        type: 'direction',
        routeId: route.route_id,
        directionId: plannedLeg?.direction_id ?? null,
        tripIds: plannedLeg ? [plannedLeg.trip_id] : []
      };
      loadJourneyRouteDirections(route, journey);
      const routeData = monitoredRouteDataRef.current.get(route.route_id);
      if (routeData) renderMap(route, routeData.shapes, routeData.stops, null, { fitBounds: false });
      renderJourneyOverlay(journey.presentation, false);
      return;
    }
    if (journey) clearActiveJourney();
    const knownDirectionId = activeRouteDirectionsRef.current[route.route_id];
    focusRouteInRouteMode(route, knownDirectionId, {
      pendingFocus: { type: 'route', routeId: route.route_id, directionId: knownDirectionId ?? null }
    });
  }

  function showJourneyDetail() {
    if (!activeJourneyRef.current) return;
    setRoutePickerOpen(false);
    setSelectedStopHighlight(null);
    setSelectedVehicleHighlight(null);
    const selection: SelectedMapItem = { type: 'journey' };
    selectedMapItemRef.current = selection;
    setSelectedMapItem(selection);
    renderJourneyOverlay(activeJourneyRef.current.presentation, false);
  }

  function focusRouteInRouteMode(
    route: RouteItem,
    directionId?: number | null,
    options: { pendingFocus?: PendingRouteFocus; preserveStopSelection?: boolean } = {}
  ) {
    const selectedDirectionId = directionId ?? null;
    const preserveStopSelection = options.preserveStopSelection === true;
    setRoutePickerOpen(false);
    if (!preserveStopSelection) selectedStopHighlightRef.current = null;
    if (options.pendingFocus) pendingRouteFocusRef.current = options.pendingFocus;
    setSelectedRoute(route);
    retainLockedRoutesAndSelect(route);
    if (!preserveStopSelection) {
      setSelectedMapItem({ type: 'route', item: route });
      setSelectedStopHighlight(null);
      setSelectedVehicleHighlight(null);
      setStopSchedule(null);
    }
    tripFocusRequestId.current += 1;
    focusedTripMapDataRef.current = null;
    routeMapViewRef.current = { type: 'direction', routeId: route.route_id, directionId: selectedDirectionId };
  }

  function activateRouteForTrip(
    route: RouteItem,
    directionId: number | null | undefined,
    tripId: string,
    pendingFocus: PendingRouteFocus
  ) {
    const selectedDirectionId = directionId ?? null;
    pendingRouteFocusRef.current = pendingFocus;
    retainLockedRoutesAndSelect(route, undefined, { tripFocused: true });
    setActiveRouteDirections((current) => ({ ...current, [route.route_id]: selectedDirectionId }));
    routeMapViewRef.current = {
      type: 'trip',
      routeId: route.route_id,
      directionId: selectedDirectionId,
      tripId
    };
    setSelectedRoute(route);
  }

  function retainLockedRoutesAndSelect(
    route: RouteItem,
    directionId?: number | null,
    options: { tripFocused?: boolean } = {}
  ) {
    const keep = new Set(retainedRouteIds(lockedRouteIdsRef.current, route.route_id));
    for (const routeId of activeRouteIdsRef.current) {
      if (!keep.has(routeId)) monitoredRouteDataRef.current.delete(routeId);
    }
    setActiveRouteIds(Array.from(keep));
    setActiveRouteDirections((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([routeId]) => keep.has(routeId)));
      if (!(route.route_id in next) || directionId !== undefined) next[route.route_id] = directionId ?? null;
      return next;
    });
    if (!options.tripFocused && (!monitoredRouteDataRef.current.has(route.route_id) || directionId !== undefined)) {
      void loadMonitoredRouteData(route, directionId);
    }
    if (!options.tripFocused) window.setTimeout(() => renderMonitoredMap(), 0);
  }

  function toggleRouteLock(route: RouteItem) {
    if (activeJourneyRef.current) clearActiveJourney();
    const isLocked = lockedRouteIdsRef.current.includes(route.route_id);
    const result = toggleLockedRouteIds(lockedRouteIdsRef.current, route.route_id, MAX_LOCKED_ROUTES);
    if (result.rejected) {
      setMessage(UI_TEXT[language].maxLockedRoutes);
      return;
    }
    setLockedRouteIds(result.routeIds);
    setActiveRouteIds((current) => current.includes(route.route_id) ? current : [...current, route.route_id]);
    if (isLocked && selectedRouteRef.current?.route_id !== route.route_id) {
      monitoredRouteDataRef.current.delete(route.route_id);
      setActiveRouteIds((current) => current.filter((routeId) => routeId !== route.route_id));
      setActiveRouteDirections((current) => {
        const next = { ...current };
        delete next[route.route_id];
        return next;
      });
      window.setTimeout(() => renderMonitoredMap(), 0);
    }
  }

  function toggleActiveRoute(route: RouteItem) {
    if (activeJourneyRef.current) clearActiveJourney();
    setActiveRouteIds((current) => {
      if (!current.includes(route.route_id)) {
        const directionId = route.route_id === selectedRouteRef.current?.route_id
          ? selectedDirectionIdRef.current
          : null;
        setActiveRouteDirections((directions) => ({ ...directions, [route.route_id]: directionId }));
        void loadMonitoredRouteData(route, directionId);
        return [...current, route.route_id];
      }
      if (route.route_id === selectedRouteRef.current?.route_id) return current;
      monitoredRouteDataRef.current.delete(route.route_id);
      setLockedRouteIds((locked) => locked.filter((routeId) => routeId !== route.route_id));
      setActiveRouteDirections((directions) => {
        const next = { ...directions };
        delete next[route.route_id];
        return next;
      });
      window.setTimeout(() => renderMonitoredMap(), 0);
      return current.filter((routeId) => routeId !== route.route_id);
    });
  }

  function selectVehicle(vehicle: VehicleItem) {
    setRoutePickerOpen(false);
    focusedTripMapDataRef.current = null;
    setSelectedVehicleHighlight(vehicle);
    setSelectedStopHighlight(null);
    const selection: SelectedMapItem = { type: 'vehicle', item: vehicle };
    selectedMapItemRef.current = selection;
    setSelectedMapItem(selection);
    const route = routeItemsRef.current.find((item) => item.route_id === vehicle.route_id) ?? selectedRouteRef.current;
    if (!route) return;
    const journey = activeJourneyRef.current;
    if (journey) {
      if (selectedRouteRef.current?.route_id !== route.route_id) {
        selectedRouteRef.current = route;
        setSelectedRoute(route);
        setActiveRouteDirections((current) => ({ ...current, [route.route_id]: vehicle.direction_id ?? null }));
        loadJourneyRouteDirections(route, journey);
      }
      if (vehicle.trip_id) void focusTripPattern(route, vehicle.trip_id, vehicle.direction_id, vehicle);
      return;
    }
    if (selectedRouteRef.current?.route_id !== route.route_id) {
      activateRouteForTrip(route, vehicle.direction_id, vehicle.trip_id, {
        type: 'vehicle',
        routeId: route.route_id,
        directionId: vehicle.direction_id,
        vehicle
      });
      return;
    }
    if (vehicle.trip_id) {
      void focusTripPattern(route, vehicle.trip_id, vehicle.direction_id, vehicle);
    }
  }

  function selectDepartureRoute(route: RouteItem, departure: DepartureItem) {
    if (activeJourneyRef.current) clearActiveJourney();
    setRoutePickerOpen(false);
    selectedStopHighlightRef.current = null;
    pendingRouteFocusRef.current = {
      type: 'route',
      routeId: route.route_id,
      directionId: departure.direction_id,
      tripId: departure.trip_id
    };
    if (selectedRouteRef.current?.route_id === route.route_id) {
      selectDirectionForDeparture(departure);
      pendingRouteFocusRef.current = null;
      setSelectedVehicleHighlight(null);
      setSelectedStopHighlight(null);
      setStopSchedule(null);
      setSelectedMapItem({ type: 'route', item: route });
      void focusTripPattern(route, departure.trip_id, departure.direction_id);
      return;
    }
    activateRouteForTrip(route, departure.direction_id, departure.trip_id, {
      type: 'route',
      routeId: route.route_id,
      directionId: departure.direction_id,
      tripId: departure.trip_id
    });
  }

  function selectDepartureVehicle(vehicle: VehicleItem, departure: DepartureItem) {
    if (activeJourneyRef.current) clearActiveJourney();
    const route = routeItems.find((item) => item.route_id === vehicle.route_id || item.route_id === departure.route_id);
    if (!route) {
      selectVehicle(vehicle);
      return;
    }
    setRoutePickerOpen(false);
    selectedStopHighlightRef.current = null;
    pendingRouteFocusRef.current = {
      type: 'vehicle',
      routeId: route.route_id,
      directionId: vehicle.direction_id ?? departure.direction_id,
      vehicle
    };
    if (selectedRouteRef.current?.route_id === route.route_id) {
      selectDirectionForDeparture({ ...departure, direction_id: vehicle.direction_id ?? departure.direction_id });
      pendingRouteFocusRef.current = null;
      setStopSchedule(null);
      selectVehicle(vehicle);
      return;
    }
    activateRouteForTrip(route, vehicle.direction_id ?? departure.direction_id, vehicle.trip_id, {
      type: 'vehicle',
      routeId: route.route_id,
      directionId: vehicle.direction_id ?? departure.direction_id,
      vehicle
    });
  }

  function changeStopPanelSelectedRouteOnly(value: boolean) {
    stopPanelSelectedRouteOnlyRef.current = value;
    setStopPanelSelectedRouteOnly(value);
    rememberStopSelectedRouteOnly(value);
    refreshSelectedStopSchedule();
  }

  async function refreshRealtime(
    showBusy = true,
    expectedRouteId = selectedRouteRef.current?.route_id,
    expectedFeedVersion = feedRef.current?.feed_version,
    expectedDirectionId = selectedDirectionIdRef.current
  ) {
    if (!expectedRouteId || !expectedFeedVersion) return;
    if (showBusy) setBusy(true);
    try {
      const activeRouteIds = activeRouteIdsRef.current.includes(expectedRouteId)
        ? activeRouteIdsRef.current
        : [expectedRouteId, ...activeRouteIdsRef.current];
      const otherRouteIds = activeRouteIds.filter((routeId) => routeId !== expectedRouteId);
      const [selectedVehicleResult, selectedAlertResult, selectedTripUpdateResult, otherVehicleResults, otherAlertResult, otherTripUpdateResult] = await Promise.all([
        vehicles([expectedRouteId], expectedDirectionId),
        alerts([expectedRouteId]),
        tripUpdates([expectedRouteId], [], [], expectedDirectionId),
        Promise.all(otherRouteIds.map((routeId) => vehicles([routeId], activeRouteDirectionsRef.current[routeId] ?? null))),
        otherRouteIds.length ? alerts(otherRouteIds) : Promise.resolve(null),
        otherRouteIds.length ? tripUpdates(otherRouteIds) : Promise.resolve(null)
      ]);
      if (
        selectedRouteRef.current?.route_id !== expectedRouteId ||
        feedRef.current?.feed_version !== expectedFeedVersion ||
        selectedDirectionIdRef.current !== expectedDirectionId
      ) return;
      const currentVehicles = mergeByKey(
        [
          ...(selectedVehicleResult.feed_version === expectedFeedVersion ? selectedVehicleResult.items : []),
          ...otherVehicleResults.flatMap((result) => result.feed_version === expectedFeedVersion ? result.items : [])
        ],
        vehicleIdentityKey
      );
      const currentAlerts = mergeByKey(
        [
          ...(selectedAlertResult.feed_version === expectedFeedVersion ? selectedAlertResult.items : []),
          ...(otherAlertResult?.feed_version === expectedFeedVersion ? otherAlertResult.items : [])
        ],
        alertIdentityKey
      ).slice(0, 10);
      const currentTripUpdates = mergeByKey(
        [
          ...(selectedTripUpdateResult.feed_version === expectedFeedVersion ? selectedTripUpdateResult.items : []),
          ...(otherTripUpdateResult?.feed_version === expectedFeedVersion ? otherTripUpdateResult.items : [])
        ],
        (item) => item.trip_id
      );
      const dedupedVehicles = commitVehicleItems(currentVehicles);
      setAlertItems(currentAlerts);
      setTripUpdateItems(currentTripUpdates);
      const route = selectedRouteRef.current;
      const routeMapView = routeMapViewRef.current;
      const shouldRenderRouteLayer = route &&
        routeMapView?.routeId === expectedRouteId &&
        selectedMapItemRef.current?.type !== 'stop';
      if (shouldRenderRouteLayer) {
        const direction = routeDirections.find((item) => item.direction_id === expectedDirectionId) ?? null;
        const fallbackShapes = shapesForDirection(routeShapesData, direction);
        const fallbackStops = direction?.stops ?? stopsRef.current;
        const realtimeTripIds = activeTripIds(currentVehicles, currentTripUpdates);
        const scheduledTripIds = routeMapView.type === 'direction'
          ? routeMapView.tripIds?.length
            ? routeMapView.tripIds
            : await loadRouteTripIds(expectedRouteId, expectedDirectionId)
          : [];
        const tripIds = routeMapView.type === 'trip'
          ? [routeMapView.tripId]
          : uniqueTripIds(scheduledTripIds, realtimeTripIds);
        const tripPatterns = await loadTripPatterns(expectedFeedVersion, tripIds);
        if (
          selectedRouteRef.current?.route_id === expectedRouteId &&
          feedRef.current?.feed_version === expectedFeedVersion &&
          selectedDirectionIdRef.current === expectedDirectionId &&
          routeMapViewRef.current === routeMapView
        ) {
          const shouldUseFallback = false;
          const existingShapeColours = routeMapViewRef.current?.routeId === expectedRouteId
            ? routeMapViewRef.current.shapeColours
            : undefined;
          const shapePlan = routeMapView.type === 'trip'
            ? focusedTripShapeRenderPlan(route, tripPatterns, shouldUseFallback ? fallbackShapes : [], existingShapeColours)
            : routeShapeRenderPlan(
                route,
                tripPatterns,
                shouldUseFallback ? fallbackShapes : [],
                routeMapView.trunkGeometryKey,
                existingShapeColours
              );
          const mapStops = stopsFromPatterns(
            tripPatterns,
            shouldUseFallback ? fallbackStops : [],
            shapePlan.colourByGeometry,
            colour(route)
          );
          if (shapePlan.shapes.length > 0 || mapStops.length > 0 || shouldUseFallback) {
            if (routeMapView.type === 'direction' && scheduledTripIds.length > 0) {
              routeMapViewRef.current = {
                ...routeMapView,
                tripIds: scheduledTripIds,
                shapeColours: shapePlan.colourByGeometry,
                trunkGeometryKey: shapePlan.trunkGeometryKey ?? routeMapView.trunkGeometryKey
              };
            } else {
              routeMapViewRef.current = {
                ...routeMapView,
                shapeColours: shapePlan.colourByGeometry,
                trunkGeometryKey: shapePlan.trunkGeometryKey ?? routeMapView.trunkGeometryKey
              };
            }
            stopsRef.current = mapStops;
            setStops(mapStops);
            renderMap(route, shapePlan.shapes, mapStops, selectedStopHighlightRef.current, { fitBounds: false });
          } else {
            renderVehicles(dedupedVehicles);
          }
        }
      } else {
        renderVehicles(dedupedVehicles);
      }
      refreshSelectedStopSchedule();
      if (showBusy) {
        const realtimeReady = selectedVehicleResult.feed_version === expectedFeedVersion && selectedAlertResult.feed_version === expectedFeedVersion;
        setMessage(
          realtimeReady
            ? currentVehicles.length > 0
              ? `${activeRouteIds.length} active ${activeRouteIds.length === 1 ? 'route' : 'routes'} refreshed`
              : 'No realtime vehicles for this direction'
            : 'Waiting for realtime data from the active static feed'
        );
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Realtime refresh failed');
    } finally {
      if (
        showBusy &&
        selectedRouteRef.current?.route_id === expectedRouteId &&
        feedRef.current?.feed_version === expectedFeedVersion
      ) setBusy(false);
    }
  }

  async function locateNearby(options: { showBusy?: boolean; flyTo?: boolean; startup?: boolean } = {}) {
    const { showBusy = true, flyTo = true, startup = false } = options;
    if (!navigator.geolocation) {
      setMessage('Geolocation is not supported by this browser');
      return;
    }

    if (locationWatchId.current != null) {
      navigator.geolocation.clearWatch(locationWatchId.current);
    }

    if (showBusy) setBusy(true);
    if (startup) setMessage('Finding your live position');
    let awaitingFirstFix = true;

    const usePosition = async (position: GeolocationPosition) => {
      const { latitude: lat, longitude: lon } = position.coords;
      updateUserMarker(lat, lon);
      if (!awaitingFirstFix) return;
      awaitingFirstFix = false;
      try {
        const result = await nearbyStops(lat, lon);
        setNearby(result.items);
        if (selectedMapItemRef.current?.type === 'nearby') {
          setSelectedMapItem({ type: 'nearby', items: result.items });
        }
        setCacheStatus(result.cache.status);
        setMessage(`Live position found; ${result.items.length} nearby stops`);
        if (flyTo) map.current?.flyTo({ center: [lon, lat], zoom: 13.2, essential: true });
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Nearby search failed');
      } finally {
        if (showBusy) setBusy(false);
      }
    };

    locationWatchId.current = navigator.geolocation.watchPosition(
      (position) => void usePosition(position),
      (error) => {
        if (awaitingFirstFix && showBusy) setBusy(false);
        awaitingFirstFix = false;
        setMessage(geolocationErrorMessage(error));
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 15_000 }
    );
  }

  function updateUserMarker(lat: number, lon: number) {
    const instance = map.current;
    if (!instance) return;
    if (!userMarker.current) {
      const element = document.createElement('div');
      element.className = 'user-location-marker';
      element.setAttribute('aria-label', 'Your live position');
      userMarker.current = new maplibregl.Marker({ element, anchor: 'center' }).setLngLat([lon, lat]).addTo(instance);
    } else {
      userMarker.current.setLngLat([lon, lat]);
    }
  }

  function selectStop(stop: StopItem, source: StopDetailSource = 'route') {
    setRoutePickerOpen(false);
    selectedStopHighlightRef.current = stop;
    setSelectedStopHighlight(stop);
    setSelectedVehicleHighlight(null);
    const selection: SelectedMapItem = { type: 'stop', item: stop, source };
    selectedMapItemRef.current = selection;
    setSelectedMapItem(selection);
    setMessage(`${stop.stop_name} selected`);
  }

  function selectJourneyStop(leg: TransitJourneyLeg, endpoint: 'from' | 'to') {
    const point = leg[endpoint];
    const plannedLeg = activeJourneyRef.current?.presentation.transit.find((item) => item.leg.trip_id === leg.trip_id);
    const stop = plannedLeg?.stops.find((item) => item.stop_id === point.stop_id) ?? {
      stop_id: point.stop_id ?? `${leg.trip_id}:${endpoint}`,
      stop_name: point.name,
      stop_lat: point.latitude,
      stop_lon: point.longitude,
      platform_code: point.platform_code ?? null
    };
    void selectStopAndFilterRoutes(stop, 'map', leg.route_id);
  }

  function refreshSelectedStopSchedule() {
    const detail = selectedMapItemRef.current;
    if (detail?.type !== 'stop') return;
    const routeIds = stopRouteFilterRef.current?.stop.stop_id === detail.item.stop_id
      ? stopRouteFilterRef.current.routeIds
      : [];
    void loadStopSchedule(detail.item, routeIds, {
      preserveItems: true,
      selectedRouteId: stopRouteFilterRef.current?.selectedRouteId,
      selectedDirectionId: stopRouteFilterRef.current?.selectedDirectionId
    });
  }

  async function loadStopSchedule(
    stop: StopItem,
    routeIds: string[] = [],
    options: { preserveItems?: boolean; selectedRouteId?: string; selectedDirectionId?: number | null } = {}
  ) {
    const requestId = ++stopScheduleRequestId.current;
    setStopSchedule((current) => ({
      stopId: stop.stop_id,
      loading: true,
      departures: options.preserveItems && current?.stopId === stop.stop_id ? current.departures : [],
      updates: options.preserveItems && current?.stopId === stop.stop_id ? current.updates : new Map(),
      vehicles: options.preserveItems && current?.stopId === stop.stop_id ? current.vehicles : new Map(),
      serviceDate: options.preserveItems && current?.stopId === stop.stop_id ? current.serviceDate : undefined
    }));
    try {
      const selectedRouteForStop = options.selectedRouteId
        ? routeItemsRef.current.find((route) => route.route_id === options.selectedRouteId) ?? selectedRouteRef.current
        : selectedRouteRef.current;
      const selectedRouteOnly = stopPanelSelectedRouteOnlyRef.current;
      const selectedDirectionId = options.selectedDirectionId ?? selectedDirectionIdRef.current;
      const selectedRouteApplies = Boolean(
        selectedRouteOnly &&
        selectedRouteForStop &&
        (routeIds.length === 0 || routeIds.includes(selectedRouteForStop.route_id))
      );
      const requestRouteIds = selectedRouteApplies && selectedRouteForStop
        ? [selectedRouteForStop.route_id]
        : routeIds;
      const requestDirectionIds = selectedRouteApplies && selectedDirectionId != null
        ? [selectedDirectionId]
        : [];
      const stopDetail = await loadStopTransitDetail(stop.stop_id, requestRouteIds, requestDirectionIds, 100);
      if (requestId !== stopScheduleRequestId.current) return;
      setStopSchedule({
        stopId: stop.stop_id,
        loading: false,
        departures: stopDetail.departures,
        updates: stopDetail.updates,
        vehicles: stopDetail.vehicles,
        serviceDate: stopDetail.serviceDate
      });
    } catch (err) {
      if (requestId !== stopScheduleRequestId.current) return;
      setStopSchedule({ stopId: stop.stop_id, loading: false, departures: [], updates: new Map(), vehicles: new Map() });
      setMessage(err instanceof Error ? err.message : 'Could not load stop timetable');
    }
  }

  async function selectStopAndFilterRoutes(stop: StopItem, source: StopDetailSource, routeId?: string) {
    selectStop(stop, source);
    const activeStopRouteId = source === 'map' && routeId && activeRouteIdsRef.current.includes(routeId)
      ? routeId
      : undefined;
    const activeStopDirectionId = activeStopRouteId
      ? activeRouteDirectionsRef.current[activeStopRouteId] ?? null
      : null;
    if (activeStopRouteId && !activeJourneyRef.current) {
      const activeRoute = routeItemsRef.current.find((route) => route.route_id === activeStopRouteId);
      if (activeRoute && selectedRouteRef.current?.route_id !== activeStopRouteId) {
        focusRouteInRouteMode(activeRoute, activeStopDirectionId, {
          pendingFocus: { type: 'route', routeId: activeStopRouteId, directionId: activeStopDirectionId },
          preserveStopSelection: true
        });
      }
    }
    setStopSchedule({ stopId: stop.stop_id, loading: true, departures: [], updates: new Map(), vehicles: new Map() });
    try {
      const result = await routesOnStops([stop.stop_id]);
      const routeIds = result.items.map((route) => route.route_id);
      const stopFilter: StopRouteFilter = {
        stop,
        routeIds,
        selectedRouteId: activeStopRouteId,
        selectedDirectionId: activeStopDirectionId
      };
      setStopRouteFilter(stopFilter);
      void loadStopSchedule(stop, routeIds, {
        selectedRouteId: activeStopRouteId,
        selectedDirectionId: activeStopDirectionId
      });
      setMessage(`${routeIds.length} routes serve ${stop.stop_name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not filter routes for this stop');
    }
  }

  function clearStopRouteFilter() {
    setStopRouteFilter(null);
    setMessage('Showing all routes');
  }

  async function toggleFavourite(route: RouteItem) {
    try {
      const isFavourite = favourites.includes(route.route_id);
      const result = isFavourite
        ? await removeFavourite(route.route_id)
        : await addFavourite(route.route_id);
      setFavourites(result.route_ids);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not update favourite route');
    }
  }

  const statusPanelActive = routePickerOpen || selectedMapItem;
  const routePickerDetail = (
    <section className="detail-card route-picker-detail-card">
      <div>
        <span>{t.routeSearch}</span>
        <strong>{stopRouteFilter ? `${t.route}: ${stopRouteFilter.stop.stop_name}` : t.chooseRoute}</strong>
        <small>{visibleRoutes.length} {visibleRoutes.length === 1 ? t.match : t.matches}</small>
      </div>
      <div className="route-picker-list detail-route-picker-list" aria-label="Filtered routes">
        {stopRouteFilter && (
          <button className="stop-route-filter" onClick={clearStopRouteFilter} title="Clear stop route filter">
            <span>{t.stop}</span>
            <strong>{stopRouteFilter.stop.stop_name}</strong>
            <X size={13} />
          </button>
        )}
        {visibleRoutes.length === 0 && <p className="route-empty">{t.noMatchingRoutes}</p>}
        {visibleRoutes.map((route) => (
          <article
            key={route.route_id}
            className={`route-card ${selectedRoute?.route_id === route.route_id ? 'active' : ''} ${activeRouteIds.includes(route.route_id) ? 'monitored' : ''}`}
          >
            <button className="route-select" onClick={() => chooseRoute(route)} title={routeLabel(route)}>
              <span className="mode-icon"><RouteModeIcon type={route.route_type} /></span>
              <span>
                <strong>{route.route_short_name || route.route_id}</strong>
                <small>{route.route_long_name || 'Unnamed route'}</small>
              </span>
              <ChevronRight size={16} />
            </button>
            <button
              className={`route-monitor-button ${activeRouteIds.includes(route.route_id) ? 'active' : ''}`}
              disabled={selectedRoute?.route_id === route.route_id}
              onClick={() => toggleActiveRoute(route)}
              title={`${activeRouteIds.includes(route.route_id) ? t.removeFromActiveRoutes : t.addToActiveRoutes}: ${routeLabel(route)}`}
            >
              <RadioTower size={13} />
            </button>
            <button
              className={`route-favourite-button ${favourites.includes(route.route_id) ? 'active' : ''}`}
              onClick={() => void toggleFavourite(route)}
              title={`${favourites.includes(route.route_id) ? 'Remove' : 'Add'} ${routeLabel(route)} ${favourites.includes(route.route_id) ? 'from' : 'to'} favourites`}
            >
              <Heart size={14} fill={favourites.includes(route.route_id) ? 'currentColor' : 'none'} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );

  const routeSidebar = (
    <aside className={`route-sidebar${controlMode === 'journey' ? ' journey-route-sidebar' : ''}`}>
        <header className="product-header view-switch-header">
          <ViewTabs
            active={controlMode}
            onMap={onControlModeChange ? () => onControlModeChange('map') : undefined}
            onJourney={onControlModeChange ? () => onControlModeChange('journey') : undefined}
          />
          <button
            className="language-toggle"
            onClick={() => setLanguage((current) => (current === 'en' ? 'mi' : 'en'))}
            title={t.otherLanguageName}
          >
            {language === 'en' ? 'MI' : 'EN'}
          </button>
        </header>

        <div className="map-route-controls" hidden={controlMode !== 'map'}>
        <div
          className="route-search-wrap"
        >
          <label className="route-search">
            <Search size={17} />
            <input
              value={query}
              onFocus={() => setRoutePickerOpen(true)}
              onChange={(event) => {
                setQuery(event.target.value);
                setRoutePickerOpen(true);
              }}
              placeholder={t.searchRoute}
            />
          </label>
        </div>

        <div className="route-mode-filter" aria-label={t.vehicleTypeFilter}>
          {routeModeOptions.map((option) => (
            <button
              key={String(option.value)}
              className={routeModeFilter === option.value ? 'active' : ''}
              onClick={() => setRouteModeFilter(option.value)}
              title={routeModeOptionLabel(option.value, t)}
            >
              {option.value !== 'all' && <RouteModeIcon type={option.iconType} size={14} />}
              <span>{routeModeOptionLabel(option.value, t)}</span>
            </button>
          ))}
        </div>

        <section className="favourite-routes" aria-label="Favourite routes">
          <h2><Star size={13} fill="currentColor" /> {t.favourites}</h2>
          <div>
            {favouriteRouteItems.length === 0 && <p>{t.noSavedRoutes}</p>}
            {favouriteRouteItems.map((route) => (
              <span
                key={route.route_id}
                className={`favourite-route-chip ${selectedRoute?.route_id === route.route_id ? 'active' : ''} ${activeRouteIds.includes(route.route_id) ? 'monitored' : ''}`}
              >
                <button
                  className="favourite-route-select"
                  onClick={() => chooseRoute(route)}
                  title={routeLabel(route)}
                >
                  {route.route_short_name || route.route_id}
                </button>
                <button
                  className="favourite-route-remove"
                  onClick={() => void toggleFavourite(route)}
                  title={`${t.removeFromFavourites}: ${routeLabel(route)}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        </section>
        </div>

        <div className="journey-control-panel" hidden={controlMode !== 'journey'}>
          <JourneyPlannerControls
            onSelectJourney={applyJourneySelection}
            onJourneyOptionsChange={setJourneyOptions}
          />
        </div>

    </aside>
  );

  return (
    <main className="app-shell">
      <section className="map-workspace">
        <section className="map-stage">
          <div ref={mapNode} className="map-canvas" />
          {(mapRouteItems.length > 0 || activeJourney) && (
            <div className="map-route-lock-rail" aria-label={t.activeRoutes}>
              {mapRouteItems.map((route) => {
                const locked = lockedRouteIds.includes(route.route_id);
                const lockLimitReached = !locked && lockedRouteIds.length >= MAX_LOCKED_ROUTES;
                return (
                  <span
                    key={route.route_id}
                    className={`map-route-lock-item ${locked ? 'locked' : ''} ${selectedRoute?.route_id === route.route_id ? 'selected' : ''}`}
                  >
                    <button
                      className="map-route-select-item"
                      title={routeLabel(route)}
                      onClick={() => chooseRoute(route)}
                    >
                      {route.route_short_name || route.route_id}
                    </button>
                    <button
                      className="map-route-lock-toggle"
                      disabled={lockLimitReached}
                      title={lockLimitReached
                        ? `${t.maxLockedRoutes}: ${routeLabel(route)}`
                        : `${locked ? t.unlockRoute : t.lockRoute}: ${routeLabel(route)}`}
                      aria-label={`${locked ? t.unlockRoute : t.lockRoute}: ${routeLabel(route)}`}
                      onClick={() => toggleRouteLock(route)}
                    >
                      {locked ? <Lock size={14} /> : <Unlock size={14} />}
                    </button>
                  </span>
                );
              })}
              {activeJourney && (
                <button
                  type="button"
                  className={`map-journey-detail-button ${selectedMapItem?.type === 'journey' ? 'selected' : ''}`}
                  onClick={showJourneyDetail}
                  title="Show planned journey"
                  aria-label="Show planned journey"
                >
                  <Route size={16} />
                </button>
              )}
            </div>
          )}
          <div className="map-control-stack">
            <button
              className={`map-alert-button ${alertItems.length > 0 ? 'has-alerts' : ''}`}
              title={`${alertItems.length} ${alertItems.length === 1 ? t.serviceAlert : t.serviceAlerts}`}
              onClick={() => {
                setRoutePickerOpen(false);
                setSelectedVehicleHighlight(null);
                setSelectedMapItem({ type: 'alerts', items: alertItems });
              }}
            >
              <AlertTriangle size={18} />
              <span>{alertItems.length}</span>
            </button>
            <div className="map-metric-chip"><strong>{stops.length}</strong><span>{t.stops}</span></div>
            <div className="map-metric-chip"><strong>{vehicleItems.length}</strong><span>{t.vehicles}</span></div>
            <button title={t.useLiveLocation} onClick={() => void locateNearby()}><LocateFixed size={18} /></button>
            <button
              className={`map-nearby-button ${nearby.length > 0 ? 'has-nearby' : ''}`}
              title={`${nearby.length} ${t.nearbyStops}`}
              onClick={() => {
                setRoutePickerOpen(false);
                setSelectedVehicleHighlight(null);
                setSelectedMapItem({ type: 'nearby', items: nearby });
              }}
            >
              <Crosshair size={18} />
              <span>{nearby.length}</span>
            </button>
            <button title={`${t.signedInAs} ${session.email}`} className="identity-button"><UserRound size={18} /></button>
            <button title={t.logout} onClick={onLogout}><LogOut size={18} /></button>
          </div>
        </section>

        <section className={`map-bottom ${statusPanelActive ? 'active' : 'empty'}`}>
          {routeSidebar}
          <footer className={`detail-dock ${statusPanelActive ? 'active' : 'empty'}`}>
            {routePickerOpen ? (
              routePickerDetail
            ) : selectedMapItem ? (
              selectedMapItem.type === 'journey' ? (
                activeJourney
                  ? <JourneyPlanDetail
                    journey={activeJourney}
                    options={journeyOptions.length ? journeyOptions : [activeJourney.selection]}
                    onSelectOption={(selection) => void applyJourneySelection(selection)}
                    onSelectStop={selectJourneyStop}
                  />
                  : <div className="empty-detail"><strong>Journey unavailable</strong><span>Plan the journey again.</span></div>
              ) : selectedMapItem.type === 'route' ? (
                <SelectedRouteDetail
                  route={selectedMapItem.item}
                  direction={routeDirections[selectedDirectionIndex] ?? null}
                  directions={routeDirections}
                  selectedDirectionIndex={selectedDirectionIndex}
                  onSelectDirection={selectDirection}
                  message={message}
                  stopCount={stops.length}
                  vehicleCount={vehicleItems.length}
                  alertCount={alertItems.length}
                  busy={busy}
                  t={t}
                />
              ) : selectedMapItem.type === 'stop' ? (
                <SelectedStopDetail
                  detail={selectedMapItem}
                  schedule={stopSchedule?.stopId === selectedMapItem.item.stop_id ? stopSchedule : null}
                  routes={routeItems}
                  selectedRoute={selectedRoute}
                  selectedDirectionId={routeDirections[selectedDirectionIndex]?.direction_id ?? null}
                  selectedRouteOnly={stopPanelSelectedRouteOnly}
                  onSelectedRouteOnlyChange={changeStopPanelSelectedRouteOnly}
                  onSelectRoute={selectDepartureRoute}
                  onSelectVehicle={selectDepartureVehicle}
                  t={t}
                />
              ) : selectedMapItem.type === 'vehicle' ? (
                <SelectedVehicleDetail
                  vehicle={selectedMapItem.item}
                  update={tripUpdatesByTrip.get(selectedMapItem.item.trip_id)}
                  routes={routeItems}
                  directions={routeDirections}
                  t={t}
                />
              ) : selectedMapItem.type === 'nearby' ? (
                <SelectedNearbyDetail
                  stops={selectedMapItem.items}
                  cacheStatus={cacheStatus}
                  onSelectStop={(stop) => void selectStopAndFilterRoutes(stop, 'nearby')}
                  t={t}
                />
              ) : (
                <SelectedAlertDetail alerts={selectedMapItem.items} t={t} />
              )
            ) : (
              <div className="empty-detail">
                <strong>{selectedRoute ? routeLabel(selectedRoute) : t.networkTitle}</strong>
                <span>{message}</span>
              </div>
            )}
          </footer>
        </section>
      </section>
    </main>
  );
}

function journeyClockTime(value: string) {
  return new Intl.DateTimeFormat('en-NZ', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function journeyDuration(option: JourneyOption) {
  const minutes = Math.max(1, Math.round(option.duration_seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} hr ${minutes % 60} min` : `${minutes} min`;
}

function journeyLegDuration(leg: JourneyOption['legs'][number]) {
  const seconds = Math.max(0, (new Date(leg.scheduled_arrival).getTime() - new Date(leg.scheduled_departure).getTime()) / 1000);
  return journeyDuration({ duration_seconds: seconds } as JourneyOption);
}

function JourneyPlanDetail({
  journey,
  options,
  onSelectOption,
  onSelectStop
}: {
  journey: ActiveJourney;
  options: JourneyPlanSelection[];
  onSelectOption: (selection: JourneyPlanSelection) => void;
  onSelectStop: (leg: TransitJourneyLeg, endpoint: 'from' | 'to') => void;
}) {
  const option = journey.selection.option;
  const warnings = [...new Set([...journey.partialErrors, ...journey.realtime.partialErrors])];
  return (
    <section className="detail-card journey-plan-detail-card">
      <div className="journey-plan-summary">
        <div id="journey-planner-dock-controls" />
        <small>{journeyClockTime(option.departure_time)} departure · {journeyDuration(option)} in vehicle · {option.transfers} transfer{option.transfers === 1 ? '' : 's'}</small>
        {options.length > 1 && (
          <div className="journey-option-picker" aria-label="Journey options">
            {options.map((candidate, index) => (
              <button
                key={candidate.option.id}
                type="button"
                className={candidate.option.id === option.id ? 'selected' : ''}
                onClick={() => onSelectOption(candidate)}
                aria-pressed={candidate.option.id === option.id}
              >
                <b>Option {index + 1}</b>
                <span>{candidate.option.legs.map((leg) => leg.route_short_name).join(' → ')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="journey-plan-leg-list" aria-label="Journey legs">
        {option.legs.map((leg, index) => (
          <article key={`${index}-${leg.trip_id}`} className="journey-plan-leg transit" style={{ borderColor: `#${(leg.route_color || '2563eb').replace('#', '')}` }}>
            <span>{leg.route_short_name}{leg.headsign ? ` · ${leg.headsign}` : ''}</span>
            <strong>
              <button type="button" className="journey-plan-stop-button" onClick={() => onSelectStop(leg, 'from')}>{leg.from.name}</button>
              <span aria-hidden="true"> → </span>
              <button type="button" className="journey-plan-stop-button" onClick={() => onSelectStop(leg, 'to')}>{leg.to.name}</button>
            </strong>
            <small>{journeyLegDuration(leg)} in vehicle</small>
          </article>
        ))}
        {warnings.length > 0 && <p className="journey-plan-warning">{warnings.join(' ')}</p>}
      </div>
    </section>
  );
}

function SelectedRouteDetail({
  route,
  direction,
  directions,
  selectedDirectionIndex,
  onSelectDirection,
  message,
  stopCount,
  vehicleCount,
  alertCount,
  busy,
  t
}: {
  route: RouteItem;
  direction: RouteDirection | null;
  directions: RouteDirection[];
  selectedDirectionIndex: number;
  onSelectDirection: (index: number) => void;
  message: string;
  stopCount: number;
  vehicleCount: number;
  alertCount: number;
  busy: boolean;
  t: UiText;
}) {
  return (
    <section className="detail-card route-detail-card">
      <div>
        <span>{busy ? t.loadingRoute : t.selectedRoute}</span>
        <strong>{routeLabel(route)}</strong>
        <small>{direction?.trip_headsign || route.route_long_name || t.directionUnavailable}</small>
        {directions.length > 1 && (
          <div className="direction-tabs route-detail-directions" aria-label={t.routeDirection}>
            {directions.map((item, index) => (
              <button
                key={`${item.direction_id ?? 'unknown'}-${item.representative_trip_id}`}
                className={selectedDirectionIndex === index ? 'active' : ''}
                onClick={() => onSelectDirection(index)}
                title={directionLabel(item, index)}
              >
                {directionLabel(item, index)}
              </button>
            ))}
          </div>
        )}
      </div>
      <dl>
        <div><dt>{t.mode}</dt><dd>{routeModeName(route.route_type, t)}</dd></div>
        <div><dt>{t.stops}</dt><dd>{stopCount}</dd></div>
        <div><dt>{t.vehicles}</dt><dd>{vehicleCount}</dd></div>
        <div><dt>{t.alerts}</dt><dd>{alertCount}</dd></div>
        <div className="detail-wide"><dt>{t.status}</dt><dd>{message}</dd></div>
      </dl>
    </section>
  );
}

function SelectedStopDetail({
  detail,
  schedule,
  routes,
  selectedRoute,
  selectedDirectionId,
  selectedRouteOnly,
  onSelectedRouteOnlyChange,
  onSelectRoute,
  onSelectVehicle,
  t
}: {
  detail: Extract<SelectedMapItem, { type: 'stop' }>;
  schedule: StopSchedule | null;
  routes: RouteItem[];
  selectedRoute: RouteItem | null;
  selectedDirectionId: number | null;
  selectedRouteOnly: boolean;
  onSelectedRouteOnlyChange: (value: boolean) => void;
  onSelectRoute: (route: RouteItem, departure: DepartureItem) => void;
  onSelectVehicle: (vehicle: VehicleItem, departure: DepartureItem) => void;
  t: UiText;
}) {
  const stop = detail.item;
  const now = Date.now();
  const departures = schedule?.departures ?? [];
  const [visibleTimetableCount, setVisibleTimetableCount] = useState(STOP_TIMETABLE_BATCH_SIZE);
  const timetableRows = useMemo(() => departures
    .filter((departure) => {
      if (!selectedRouteOnly || !selectedRoute) return true;
      if (departure.route_id !== selectedRoute.route_id) return false;
      return selectedDirectionId == null ||
        departure.direction_id == null ||
        departure.direction_id === selectedDirectionId;
    })
    .map((departure) => {
      const route = routes.find((item) => item.route_id === departure.route_id);
      const update = schedule?.updates.get(departure.trip_id);
      const vehicle = schedule?.vehicles.get(departure.trip_id);
      const timing = adjustedDepartureTiming(departure, update, schedule?.serviceDate);
      return { departure, route, vehicle, timing };
    })
    .filter((row) => row.timing.epochMs == null || row.timing.epochMs >= now - 2 * 60 * 1000)
    .sort((a, b) => (a.timing.epochMs ?? Number.MAX_SAFE_INTEGER) - (b.timing.epochMs ?? Number.MAX_SAFE_INTEGER))
  , [departures, now, routes, schedule, selectedDirectionId, selectedRoute, selectedRouteOnly]);
  const visibleTimetableRows = timetableRows.slice(0, visibleTimetableCount);
  const emptyTimetableMessage = selectedRouteOnly && selectedRoute && departures.length > 0
    ? t.noUpcomingSelectedRouteOnly
    : t.noUpcoming;

  useEffect(() => {
    setVisibleTimetableCount(STOP_TIMETABLE_BATCH_SIZE);
  }, [stop.stop_id, schedule?.stopId, selectedRoute?.route_id, selectedDirectionId, selectedRouteOnly]);

  function revealMoreTimetableRows(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 24) return;
    setVisibleTimetableCount((count) => Math.min(count + STOP_TIMETABLE_BATCH_SIZE, timetableRows.length));
  }

  return (
    <section className="detail-card stop-detail-card">
      <header>
        <span>{detail.source === 'nearby' ? t.nearbyStop : detail.source === 'map' ? t.mapStop : t.routeStop}</span>
        <strong>{stop.stop_name}</strong>
        <small>{t.platform} {stop.platform_code || stop.stop_code || '-'}</small>
        <label className="stop-route-toggle">
          <input
            type="checkbox"
            checked={selectedRouteOnly}
            onChange={(event) => onSelectedRouteOnlyChange(event.target.checked)}
            disabled={!selectedRoute}
          />
          <span>{t.selectedRouteOnly}</span>
        </label>
      </header>
      <div className="stop-timetable" aria-label={t.upcomingTimetable} onScroll={revealMoreTimetableRows}>
        {schedule?.loading && <p>{t.loadingUpcoming}</p>}
        {!schedule?.loading && timetableRows.length === 0 && <p>{emptyTimetableMessage}</p>}
        {visibleTimetableRows.map(({ departure, route, vehicle, timing }) => {
          return (
            <article key={`${departure.trip_id}-${departure.stop_id}`}>
              {route ? (
                <button className="timetable-route" onClick={() => onSelectRoute(route, departure)} title={routeLabel(route)}>
                  {route.route_short_name || route.route_id}
                </button>
              ) : (
                <span className="timetable-route">{departure.route_id}</span>
              )}
              <span className="timetable-headsign">{departure.trip_headsign || route?.route_long_name || t.directionUnavailable}</span>
              {vehicle ? (
                <button className="timetable-vehicle" onClick={() => onSelectVehicle(vehicle, departure)} title={vehicleLabel(vehicle)}>
                  {vehicleLabel(vehicle)}
                </button>
              ) : (
                <span className="timetable-vehicle">{vehicleLabel(vehicle)}</span>
              )}
              <span className="timetable-time">
                <strong>{timing.adjustedTime}</strong>
                <small>{timing.minutesAway}</small>
              </span>
              <span className={timing.delaySeconds && timing.delaySeconds > 0 ? 'delay late' : 'delay'}>
                {delayLabel(timing.delaySeconds, t)}
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type HandledMapClick = MouseEvent & { mapItemHandled?: boolean };

function markMapItemClick(event: maplibregl.MapMouseEvent) {
  (event.originalEvent as HandledMapClick).mapItemHandled = true;
}

function isMapItemClick(event: maplibregl.MapMouseEvent) {
  return Boolean((event.originalEvent as HandledMapClick).mapItemHandled);
}

function isPortraitViewport() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(orientation: portrait)').matches || window.innerWidth <= 720;
}

function routeModeName(routeType: number | null | undefined, t: UiText = UI_TEXT.en) {
  if (routeType === 2) return t.train;
  if (routeType === 3) return t.bus;
  if (routeType === 4) return t.ferry;
  return t.other;
}

function routeModeOptionLabel(value: RouteModeFilter, t: UiText) {
  if (value === 'all') return t.all;
  if (value === 'other') return t.other;
  return routeModeName(value, t);
}

function adjustedDepartureTiming(departure: DepartureItem, update: TripUpdateItem | undefined, serviceDate?: string) {
  const timing = realtimeTimingForStop(departure, update, serviceDate);
  const realtimeEvent = timing.event;
  const delaySeconds = timing.delaySeconds;
  const fallbackSeconds = departure.scheduled_departure_seconds + delaySeconds;
  const adjustedTime = realtimeEvent?.time
    ? formatRealtimeEpoch(realtimeEvent.time)
    : formatGtfsSeconds(fallbackSeconds);
  return {
    adjustedTime,
    delaySeconds,
    epochMs: realtimeEvent?.time
      ? realtimeEvent.time * 1000
      : epochMsFromGtfsSeconds(fallbackSeconds, serviceDate),
    minutesAway: realtimeEvent?.time
      ? minutesAwayFromEpochLabel(realtimeEvent.time)
      : minutesAwayLabel(fallbackSeconds, serviceDate)
  };

}

function realtimeTimingForStop(departure: DepartureItem, update: TripUpdateItem | undefined, serviceDate?: string) {
  const baselineDelay = update?.delay ?? 0;
  if (!update) return { event: null as RealtimeTimeEvent | null, delaySeconds: baselineDelay };

  const orderedUpdates = [...update.stop_time_updates].sort((a, b) => (
    (a.stop_sequence ?? Number.MAX_SAFE_INTEGER) - (b.stop_sequence ?? Number.MAX_SAFE_INTEGER)
  ));
  const targetSequence = departure.stop_sequence ?? null;
  let cascadedDelay = baselineDelay;
  let targetEvent: RealtimeTimeEvent | null = null;

  for (const item of orderedUpdates) {
    const event = item.departure ?? item.arrival ?? null;
    const isTarget = item.stop_id === departure.stop_id ||
      (targetSequence != null && item.stop_sequence === targetSequence);
    const isAfterTarget = targetSequence != null &&
      item.stop_sequence != null &&
      item.stop_sequence > targetSequence;

    if (isTarget) {
      targetEvent = event;
      if (event?.delay != null) cascadedDelay = event.delay;
      else if (event?.time != null) cascadedDelay = delayFromRealtimeTime(event.time, departure, serviceDate) ?? cascadedDelay;
      break;
    }

    if (isAfterTarget) break;

    if (event?.delay != null) cascadedDelay = event.delay;
  }

  return { event: targetEvent, delaySeconds: cascadedDelay };
}

function delayFromRealtimeTime(realtimeSeconds: number, departure: DepartureItem, serviceDate?: string) {
  if (!serviceDate) return null;
  const serviceStart = new Date(`${serviceDate}T00:00:00`);
  const scheduledEpochSeconds = Math.round(serviceStart.getTime() / 1000) + departure.scheduled_departure_seconds;
  return realtimeSeconds - scheduledEpochSeconds;
}

function formatGtfsSeconds(seconds: number) {
  const daySeconds = ((seconds % 86400) + 86400) % 86400;
  const hours = Math.floor(daySeconds / 3600);
  const minutes = Math.floor((daySeconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function epochMsFromGtfsSeconds(gtfsSeconds: number, serviceDate?: string) {
  if (!serviceDate) return null;
  const serviceStart = new Date(`${serviceDate}T00:00:00`);
  return serviceStart.getTime() + gtfsSeconds * 1000;
}

function minutesAwayFromEpochLabel(epochSeconds: number) {
  const minutes = Math.round((epochSeconds * 1000 - Date.now()) / 60000);
  if (minutes <= 0) return 'due';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function minutesAwayLabel(gtfsSeconds: number, serviceDate?: string) {
  if (!serviceDate) return '';
  const serviceStart = new Date(`${serviceDate}T00:00:00`);
  const departureTime = serviceStart.getTime() + gtfsSeconds * 1000;
  const minutes = Math.round((departureTime - Date.now()) / 60000);
  if (minutes <= 0) return 'due';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function SelectedVehicleDetail({
  vehicle,
  update,
  routes,
  directions,
  t
}: {
  vehicle: VehicleItem;
  update?: TripUpdateItem;
  routes: RouteItem[];
  directions: RouteDirection[];
  t: UiText;
}) {
  const route = routes.find((item) => item.route_id === vehicle.route_id);
  return (
    <section className="detail-card">
      <div>
        <span>{t.realtimeVehicle}</span>
        <strong>{vehicleLabel(vehicle)}</strong>
        <small>{vehicle.vehicle_license_plate || t.noLicensePlate}</small>
      </div>
      <dl>
        <div><dt>{t.trip}</dt><dd>{vehicleTripHeadsign(vehicle, directions, route)}</dd></div>
        <div><dt>{t.route}</dt><dd>{route ? routeLabel(route) : vehicle.route_id || '-'}</dd></div>
        <div><dt>{t.service}</dt><dd>{formatScheduleRelationship(vehicle.schedule_relationship, t)}</dd></div>
        <div><dt>{t.status}</dt><dd>{delayLabel(update?.delay ?? null, t)}</dd></div>
        <div><dt>{t.updated}</dt><dd>{vehicle.timestamp ? formatRealtimeEpoch(vehicle.timestamp) : '-'}</dd></div>
        <div><dt>{t.speed}</dt><dd>{formatVehicleSpeed(vehicle.position.speed)}</dd></div>
        <div><dt>{t.occupancy}</dt><dd>{formatOccupancyStatus(vehicle.occupancy_status)}</dd></div>
      </dl>
    </section>
  );
}

function SelectedAlertDetail({ alerts, t }: { alerts: AlertItem[]; t: UiText }) {
  return (
    <section className="detail-card alert-detail-card">
      <div>
        <span>{t.serviceAlertsTitle}</span>
        <strong>{alerts.length} {alerts.length === 1 ? t.warning : t.warnings}</strong>
        <small>{alerts.length > 0 ? t.currentRouteNotices : t.noCurrentRouteNotices}</small>
      </div>
      <div className="alert-detail-list">
        {alerts.length === 0 && <p>{t.noCurrentAlerts}</p>}
        {alerts.map((alert) => (
          <article key={alert.alert_id}>
            <strong>{alert.header ?? alert.effect ?? t.serviceAlert}</strong>
            <p>{alert.description ?? alert.cause ?? t.noExtraDetail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function SelectedNearbyDetail({
  stops,
  cacheStatus,
  onSelectStop,
  t
}: {
  stops: StopItem[];
  cacheStatus: string;
  onSelectStop: (stop: StopItem) => void;
  t: UiText;
}) {
  return (
    <section className="detail-card nearby-detail-card">
      <div>
        <span>{t.nearbyStops}</span>
        <strong>{stops.length} {stops.length === 1 ? t.stop : t.stops}</strong>
        <small>{cacheStatus}</small>
      </div>
      <div className="nearby-detail-list">
        {stops.length === 0 && <p>{t.useLiveLocationForNearby}</p>}
        {stops.map((stop) => (
          <button key={stop.stop_id} onClick={() => onSelectStop(stop)} title={stop.stop_name}>
            <span>{stop.distance_m ? `${stop.distance_m}m` : '-'}</span>
            <strong>{stop.stop_name}</strong>
            <small>{t.platform} {stop.platform_code || stop.stop_code || '-'}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function vehicleTripHeadsign(vehicle: VehicleItem, directions: RouteDirection[], route: RouteItem | undefined) {
  const direction = directions.find((item) => item.direction_id === vehicle.direction_id);
  return direction?.trip_headsign || route?.route_long_name || '-';
}

function formatVehicleSpeed(speed: number | null | undefined) {
  if (speed == null) return '-';
  return `${Math.round(speed)} km/h`;
}

function formatScheduleRelationship(relationship: string | null | undefined, t: UiText) {
  switch (relationship) {
    case 'ADDED':
      return t.extraService;
    case 'REPLACEMENT':
      return t.replacementService;
    case 'DUPLICATED':
      return t.duplicatedService;
    default:
      return t.scheduledService;
  }
}

function upsertSource<T extends Point | LineString>(map: maplibregl.Map, id: string, data: FeatureCollection<T>) {
  const existing = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (existing) existing.setData(data);
  else map.addSource(id, { type: 'geojson', data });
}

function runWhenStyleReady(map: maplibregl.Map, callback: () => void) {
  if (map.isStyleLoaded()) {
    callback();
    return;
  }

  const retry = () => {
    if (!map.isStyleLoaded()) return;
    map.off('load', retry);
    map.off('styledata', retry);
    map.off('idle', retry);
    callback();
  };

  map.on('load', retry);
  map.on('styledata', retry);
  map.on('idle', retry);
}

function shapesForDirection(shapes: RouteShape[], direction: RouteDirection | null) {
  if (!direction) return shapes;
  const matching = shapes.filter((shape) => shape.direction_id === direction.direction_id);
  return matching.length > 0 ? matching : shapes;
}

function directionLabel(direction: RouteDirection, index: number) {
  const destination = direction.trip_headsign || direction.stops[direction.stops.length - 1]?.stop_name;
  return destination || `Direction ${direction.direction_id ?? index + 1}`;
}

function geolocationErrorMessage(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) return 'Location permission was denied';
  if (error.code === error.POSITION_UNAVAILABLE) return 'Your current position is unavailable';
  if (error.code === error.TIMEOUT) return 'Timed out while finding your current position';
  return 'Could not determine your current position';
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}
