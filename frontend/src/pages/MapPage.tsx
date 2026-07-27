import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  AlertTriangle,
  ChevronRight,
  Crosshair,
  Heart,
  LocateFixed,
  LogOut,
  Search,
  Star,
  UserRound,
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
  nextDepartures,
  removeFavourite,
  routeShapes,
  routeStops,
  routesOnStops,
  streamRealtime,
  tripUpdates,
  vehicles,
  vehiclesForTrips
} from '../api/client';
import type { Session } from '../auth/session';
import type {
  AlertItem,
  DepartureItem,
  FeedResponse,
  RouteDirection,
  RouteItem,
  RouteShape,
  RealtimeTimeEvent,
  StopItem,
  TripUpdateItem,
  VehicleItem
} from '../types/domain';
import { RouteModeIcon } from '../components/RouteModeIcon';

type Props = {
  session: Session;
  onLogout: () => void;
};

type SelectedMapItem =
  | { type: 'route'; item: RouteItem }
  | { type: 'stop'; item: StopItem; source: 'route' | 'nearby' | 'map' }
  | { type: 'vehicle'; item: VehicleItem }
  | { type: 'alerts'; items: AlertItem[] }
  | { type: 'nearby'; items: StopItem[] };

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

type PendingRouteFocus =
  | { type: 'route'; routeId: string; directionId?: number | null }
  | { type: 'vehicle'; routeId: string; directionId?: number | null; vehicle: VehicleItem };

const AUCKLAND: [number, number] = [174.7633, -36.8485];
const SELECTED_ROUTE_STORAGE_KEY = 'at-public-note:selected-route-id';
const STOP_SELECTED_ROUTE_ONLY_STORAGE_KEY = 'at-public-note:stop-selected-route-only';
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
    status: 'Status',
    updated: 'Updated',
    speed: 'Speed',
    occupancy: 'Occupancy',
    platform: 'Platform',
    selectedRouteOnly: 'Selected route only',
    upcomingTimetable: 'Upcoming vehicle timetable',
    loadingUpcoming: 'Loading upcoming vehicles...',
    noUpcoming: 'No upcoming vehicles found.',
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
    status: 'Tūnga',
    updated: 'Kua whakahōu',
    speed: 'Tere',
    occupancy: 'Kikī',
    platform: 'Papa tū',
    selectedRouteOnly: 'Ko te ararere tīpakohia anake',
    upcomingTimetable: 'Wātaka waka e haere mai ana',
    loadingUpcoming: 'E uta ana ngā waka e haere mai ana...',
    noUpcoming: 'Kāore he waka e haere mai ana.',
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
const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL?.trim();
const DEFAULT_MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'openstreetmap-tiles': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Map Data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }
  },
  layers: [
    {
      id: 'openstreetmap-basemap',
      type: 'raster',
      source: 'openstreetmap-tiles'
    }
  ]
};

function colour(route: RouteItem) {
  const value = route.route_color?.replace('#', '') || '0f766e';
  return `#${value}`;
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

function vehicleModeKey(routeType: number | null | undefined) {
  if (routeType === 2) return 'train';
  if (routeType === 4) return 'ferry';
  return 'bus';
}

function vehicleImageId(route: RouteItem | null) {
  const routeColour = route ? colour(route).replace(/[^a-zA-Z0-9]/g, '') : '0f766e';
  return `vehicle-${vehicleModeKey(route?.route_type)}-${routeColour}`;
}

function ensureVehicleImage(mapInstance: maplibregl.Map, route: RouteItem | null) {
  const imageId = vehicleImageId(route);
  if (mapInstance.hasImage(imageId)) return imageId;

  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return imageId;

  const routeColour = route ? colour(route) : '#0f766e';
  context.clearRect(0, 0, size, size);
  context.fillStyle = routeColour;
  context.strokeStyle = '#ffffff';
  context.lineWidth = 4;
  context.beginPath();
  context.arc(size / 2, size / 2, 18, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.fillStyle = '#ffffff';
  context.strokeStyle = '#ffffff';
  context.lineWidth = 2.2;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  const mode = vehicleModeKey(route?.route_type);
  if (mode === 'train') {
    context.fillRect(14, 11, 16, 18);
    context.fillStyle = routeColour;
    context.fillRect(17, 14, 4, 5);
    context.fillRect(23, 14, 4, 5);
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(16, 33);
    context.lineTo(20, 29);
    context.moveTo(28, 33);
    context.lineTo(24, 29);
    context.stroke();
  } else if (mode === 'ferry') {
    context.beginPath();
    context.moveTo(13, 25);
    context.lineTo(31, 25);
    context.lineTo(27, 31);
    context.lineTo(17, 31);
    context.closePath();
    context.fill();
    context.fillRect(17, 15, 10, 7);
    context.fillStyle = routeColour;
    context.fillRect(19, 17, 3, 3);
    context.fillRect(24, 17, 3, 3);
    context.fillStyle = '#ffffff';
  } else {
    context.fillRect(12, 13, 20, 16);
    context.fillStyle = routeColour;
    context.fillRect(15, 16, 5, 5);
    context.fillRect(24, 16, 5, 5);
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.arc(17, 31, 2.2, 0, Math.PI * 2);
    context.arc(27, 31, 2.2, 0, Math.PI * 2);
    context.fill();
  }

  mapInstance.addImage(imageId, context.getImageData(0, 0, size, size), { pixelRatio: 2 });
  return imageId;
}

function vehicleFeatures(items: VehicleItem[], route: RouteItem | null = null): Feature<Point>[] {
  const imageId = vehicleImageId(route);
  return items
    .filter((item) => item.position.latitude != null && item.position.longitude != null)
    .map((item) => ({
      type: 'Feature',
      properties: {
        vehicle_key: vehicleIdentityKey(item),
        id: item.vehicle_id,
        trip_id: item.trip_id,
        bearing: item.position.bearing ?? 0,
        mode_image: imageId
      },
      geometry: { type: 'Point', coordinates: [item.position.longitude!, item.position.latitude!] }
    }));
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

export function MapPage({ session, onLogout }: Props) {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const feedRefreshInFlight = useRef(false);
  const routeSelectionLoaded = useRef(false);
  const routeRequestId = useRef(0);
  const stopScheduleRequestId = useRef(0);
  const feedRef = useRef<FeedResponse | null>(null);
  const selectedRouteRef = useRef<RouteItem | null>(null);
  const selectedDirectionIdRef = useRef<number | null>(null);
  const selectedMapItemRef = useRef<SelectedMapItem | null>(null);
  const selectedStopHighlightRef = useRef<StopItem | null>(null);
  const stopRouteFilterRef = useRef<{ stop: StopItem; routeIds: string[] } | null>(null);
  const stopsRef = useRef<StopItem[]>([]);
  const vehicleItemsRef = useRef<VehicleItem[]>([]);
  const pendingRouteFocusRef = useRef<PendingRouteFocus | null>(null);
  const startupLocateStarted = useRef(false);
  const mapBackgroundClickBound = useRef(false);
  const userMarker = useRef<maplibregl.Marker | null>(null);
  const locationWatchId = useRef<number | null>(null);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [routeItems, setRouteItems] = useState<RouteItem[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteItem | null>(null);
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
  const [stopRouteFilter, setStopRouteFilter] = useState<{ stop: StopItem; routeIds: string[] } | null>(null);
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [favourites, setFavourites] = useState<string[]>([]);
  const [message, setMessage] = useState('Loading active feed');
  const [cacheStatus, setCacheStatus] = useState('ready');
  const [busy, setBusy] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [sseReconnectToken, setSseReconnectToken] = useState(0);

  feedRef.current = feed;
  selectedRouteRef.current = selectedRoute;
  selectedDirectionIdRef.current = routeDirections[selectedDirectionIndex]?.direction_id ?? null;
  selectedMapItemRef.current = selectedMapItem;
  selectedStopHighlightRef.current = selectedStopHighlight;
  stopRouteFilterRef.current = stopRouteFilter;
  stopsRef.current = stops;

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

  const tripUpdatesByTrip = useMemo(
    () => new Map(tripUpdateItems.map((item) => [item.trip_id, item])),
    [tripUpdateItems]
  );
  const t = UI_TEXT[language];

  useEffect(() => {
    if (!mapNode.current || map.current) return;
    const instance = new maplibregl.Map({
      container: mapNode.current,
      style: MAP_STYLE_URL || DEFAULT_MAP_STYLE,
      center: AUCKLAND,
      zoom: 10.7,
      attributionControl: false
    });
    instance.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    instance.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'Public Transport Data &copy; <a href="https://at.govt.nz/about-us/at-data-sources/general-transit-feed-specification">Auckland Transport</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)'
    }), 'bottom-right');
    const markMapReady = () => {
      if (instance.isStyleLoaded()) setMapReady(true);
    };
    instance.on('load', markMapReady);
    instance.on('styledata', markMapReady);
    instance.on('idle', markMapReady);
    map.current = instance;
    if (!startupLocateStarted.current) {
      startupLocateStarted.current = true;
      void locateNearby({ showBusy: false, flyTo: true, startup: true });
    }
    return () => {
      if (locationWatchId.current != null) navigator.geolocation.clearWatch(locationWatchId.current);
      userMarker.current?.remove();
      userMarker.current = null;
      instance.off('load', markMapReady);
      instance.off('styledata', markMapReady);
      instance.off('idle', markMapReady);
      instance.remove();
      map.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !selectedRoute || routeShapesData.length === 0) return;
    const direction = routeDirections[selectedDirectionIndex] ?? null;
    renderMap(selectedRoute, shapesForDirection(routeShapesData, direction), stops, selectedStopHighlight);
  }, [mapReady, selectedRoute?.route_id, routeShapesData, routeDirections, selectedDirectionIndex, stops]);

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
        setSelectedRoute(
          routeResult.items.find((route) => route.route_id === savedRouteId) ?? routeResult.items[0] ?? null
        );
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
    if (!feed || !selectedRoute) return;
    const controller = new AbortController();
    const requestId = ++routeRequestId.current;
    void loadRoute(selectedRoute, feed.feed_version, requestId, controller.signal);
    return () => controller.abort();
  }, [feed?.feed_version, selectedRoute?.route_id]);

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
    if (!feed || !selectedRoute) return;
    const controller = new AbortController();
    let reconnectTimer: number | undefined;

    const connect = async () => {
      try {
        await streamRealtime([selectedRoute.route_id], (event) => {
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
  }, [feed?.feed_version, selectedRoute?.route_id, sseReconnectToken]);

  useEffect(() => {
    if (!feed) return;
    const timer = window.setInterval(() => void refreshActiveFeed(), 60_000);
    return () => window.clearInterval(timer);
  }, [feed?.feed_version]);

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

  async function refreshActiveFeed() {
    if (feedRefreshInFlight.current) return;
    feedRefreshInFlight.current = true;
    try {
      const active = await activeFeed();
      if (active.feed_version === feed?.feed_version) return;
      const routeResult = await allRoutes(active.feed_version);
      setFeed(active);
      setRouteItems(routeResult.items);
      setSelectedRoute((current) => routeResult.items.find((route) => route.route_id === current?.route_id) ?? routeResult.items[0] ?? null);
      commitVehicleItems([]);
      setAlertItems([]);
      setTripUpdateItems([]);
      setSelectedMapItem(null);
      setSelectedStopHighlight(null);
      setSelectedVehicleHighlight(null);
      setStopSchedule(null);
      setStopRouteFilter(null);
      setMessage(`Static feed updated; ${routeResult.page.total} routes available`);
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
      const currentVehicles = realtimeMatches(vehicleResult.feed_version) ? vehicleResult.items : [];
      const currentAlerts = realtimeMatches(alertResult.feed_version) ? alertResult.items.slice(0, 10) : [];
      const currentTripUpdates = realtimeMatches(tripUpdateResult.feed_version) ? tripUpdateResult.items : [];
      setRouteShapesData(shapeResult.items);
      setRouteDirections(availableDirections);
      setSelectedDirectionIndex(primaryDirectionIndex);
      setStops(primaryStops);
      commitVehicleItems(currentVehicles);
      setAlertItems(currentAlerts);
      setTripUpdateItems(currentTripUpdates);
      const highlightedStop = selectedMapItemRef.current?.type === 'stop'
        ? selectedMapItemRef.current.item
        : selectedStopHighlightRef.current;
      if (pendingFocus?.type === 'vehicle') {
        setSelectedVehicleHighlight(pendingFocus.vehicle);
        setSelectedStopHighlight(null);
        setSelectedMapItem({ type: 'vehicle', item: pendingFocus.vehicle });
        pendingRouteFocusRef.current = null;
      } else if (pendingFocus?.type === 'route') {
        setSelectedVehicleHighlight(null);
        setSelectedStopHighlight(null);
        setSelectedMapItem({ type: 'route', item: route });
        pendingRouteFocusRef.current = null;
      } else if (!isPortraitViewport() || selectedMapItemRef.current?.type === 'route') {
        setSelectedMapItem({ type: 'route', item: route });
      }
      const stopToHighlight = pendingFocus ? null : highlightedStop;
      setSelectedStopHighlight(stopToHighlight);
      renderMap(route, primaryShapes, primaryStops, stopToHighlight);
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

  function renderMap(route: RouteItem, shapes: RouteShape[], routeStopItems: StopItem[], highlightedStop: StopItem | null = selectedStopHighlight) {
    const instance = map.current;
    if (!instance) return;

    const paintRoute = () => {
      if (selectedRouteRef.current?.route_id !== route.route_id) return;
      const shapeFeatures: Feature<LineString>[] = shapes.map((shape) => ({
        type: 'Feature',
        properties: { shape_id: shape.shape_id },
        geometry: shape.geometry
      }));
      const stopFeatures: Feature<Point>[] = routeStopItems.map((stop) => ({
        type: 'Feature',
        properties: { stop_id: stop.stop_id, name: stop.stop_name },
        geometry: { type: 'Point', coordinates: [stop.stop_lon, stop.stop_lat] }
      }));
      const routeCollection: FeatureCollection<LineString> = { type: 'FeatureCollection', features: shapeFeatures };
      const stopCollection: FeatureCollection<Point> = { type: 'FeatureCollection', features: stopFeatures };
      ensureVehicleImage(instance, route);
      const vehicleCollection: FeatureCollection<Point> = { type: 'FeatureCollection', features: vehicleFeatures(vehicleItemsRef.current, route) };

      upsertSource(instance, 'route-shapes', routeCollection);
      upsertSource(instance, 'route-stops', stopCollection);
      upsertSource(instance, 'route-vehicles', vehicleCollection);

      if (!instance.getLayer('route-line')) {
        instance.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route-shapes',
          paint: { 'line-color': colour(route), 'line-width': 4.5, 'line-opacity': 0.88 }
        });
      } else {
        instance.setPaintProperty('route-line', 'line-color', colour(route));
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
          const stop = stopsRef.current.find((item) => item.stop_id === stopId);
          if (stop) void selectStopAndFilterRoutes(stop, 'map');
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

      renderSelectedStopHighlight(highlightedStop);

      const coordinates = shapes.flatMap((shape) => shape.geometry.coordinates);
      if (coordinates.length) {
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

  function renderSelectedStopHighlight(stop: StopItem | null) {
    const instance = map.current;
    if (!instance) return;

    const paintHighlight = () => {
      const stopFeatures: Feature<Point>[] = stop
        ? [{
            type: 'Feature',
            properties: { stop_id: stop.stop_id, name: stop.stop_name },
            geometry: { type: 'Point', coordinates: [stop.stop_lon, stop.stop_lat] }
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
      ensureVehicleImage(instance, selectedRouteRef.current);
      source.setData({ type: 'FeatureCollection', features: vehicleFeatures(items, selectedRouteRef.current) });
    }
  }

  function selectDirection(index: number) {
    if (!selectedRoute) return;
    const direction = routeDirections[index];
    if (!direction) return;
    selectedDirectionIdRef.current = direction.direction_id ?? null;
    setSelectedDirectionIndex(index);
    setStops(direction.stops);
    commitVehicleItems([]);
    setSelectedMapItem({ type: 'route', item: selectedRoute });
    setSelectedStopHighlight(null);
    setSelectedVehicleHighlight(null);
    setStopSchedule(null);
    renderMap(
      selectedRoute,
      shapesForDirection(routeShapesData, direction),
      direction.stops,
      null
    );
    if (feed?.feed_version) void refreshRealtime(true, selectedRoute.route_id, feed.feed_version, direction.direction_id);
    setMessage(`${directionLabel(direction, index)} selected`);
  }

  function selectDirectionForDeparture(departure: DepartureItem) {
    if (departure.direction_id == null) return false;
    const index = routeDirections.findIndex((direction) => direction.direction_id === departure.direction_id);
    if (index < 0) return false;
    if (index !== selectedDirectionIndex) selectDirection(index);
    return true;
  }

  function chooseRoute(route: RouteItem) {
    setRoutePickerOpen(false);
    selectedStopHighlightRef.current = null;
    setSelectedRoute(route);
    setSelectedMapItem({ type: 'route', item: route });
    setSelectedStopHighlight(null);
    setSelectedVehicleHighlight(null);
    setStopSchedule(null);
  }

  function selectVehicle(vehicle: VehicleItem) {
    setRoutePickerOpen(false);
    setSelectedVehicleHighlight(vehicle);
    setSelectedStopHighlight(null);
    setSelectedMapItem({ type: 'vehicle', item: vehicle });
  }

  function selectDepartureRoute(route: RouteItem, departure: DepartureItem) {
    setRoutePickerOpen(false);
    selectedStopHighlightRef.current = null;
    pendingRouteFocusRef.current = { type: 'route', routeId: route.route_id, directionId: departure.direction_id };
    if (selectedRouteRef.current?.route_id === route.route_id) {
      selectDirectionForDeparture(departure);
      pendingRouteFocusRef.current = null;
      setSelectedVehicleHighlight(null);
      setSelectedStopHighlight(null);
      setStopSchedule(null);
      setSelectedMapItem({ type: 'route', item: route });
      return;
    }
    setSelectedRoute(route);
  }

  function selectDepartureVehicle(vehicle: VehicleItem, departure: DepartureItem) {
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
    setSelectedRoute(route);
  }

  function changeStopPanelSelectedRouteOnly(value: boolean) {
    setStopPanelSelectedRouteOnly(value);
    rememberStopSelectedRouteOnly(value);
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
      const [vehicleResult, alertResult, tripUpdateResult] = await Promise.all([
        vehicles([expectedRouteId], expectedDirectionId),
        alerts([expectedRouteId]),
        tripUpdates([expectedRouteId], [], [], expectedDirectionId)
      ]);
      if (
        selectedRouteRef.current?.route_id !== expectedRouteId ||
        feedRef.current?.feed_version !== expectedFeedVersion ||
        selectedDirectionIdRef.current !== expectedDirectionId
      ) return;
      const currentVehicles = vehicleResult.feed_version === expectedFeedVersion ? vehicleResult.items : [];
      const currentAlerts = alertResult.feed_version === expectedFeedVersion ? alertResult.items.slice(0, 10) : [];
      const currentTripUpdates = tripUpdateResult.feed_version === expectedFeedVersion ? tripUpdateResult.items : [];
      const dedupedVehicles = commitVehicleItems(currentVehicles);
      setAlertItems(currentAlerts);
      setTripUpdateItems(currentTripUpdates);
      renderVehicles(dedupedVehicles);
      refreshSelectedStopSchedule();
      if (showBusy) {
        const realtimeReady = vehicleResult.feed_version === expectedFeedVersion && alertResult.feed_version === expectedFeedVersion;
        setMessage(
          realtimeReady
            ? currentVehicles.length > 0
              ? 'Realtime refreshed'
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
    setSelectedMapItem({ type: 'stop', item: stop, source });
    setMessage(`${stop.stop_name} selected`);
  }

  function refreshSelectedStopSchedule() {
    const detail = selectedMapItemRef.current;
    if (detail?.type !== 'stop') return;
    const routeIds = stopRouteFilterRef.current?.stop.stop_id === detail.item.stop_id
      ? stopRouteFilterRef.current.routeIds
      : [];
    void loadStopSchedule(detail.item, routeIds, { preserveItems: true });
  }

  async function loadStopSchedule(stop: StopItem, routeIds: string[] = [], options: { preserveItems?: boolean } = {}) {
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
      const departureResult = await nextDepartures([stop.stop_id], routeIds, undefined, 100);
      if (requestId !== stopScheduleRequestId.current) return;
      const tripIds = departureResult.items.map((item) => item.trip_id);
      const [updateResult, vehicleResult] = tripIds.length > 0
        ? await Promise.all([
            tripUpdates([], [], tripIds),
            vehiclesForTrips(tripIds)
          ])
        : [
            { feed_version: departureResult.feed_version, items: [] },
            { feed_version: departureResult.feed_version, items: [] }
          ];
      if (requestId !== stopScheduleRequestId.current) return;
      setStopSchedule({
        stopId: stop.stop_id,
        loading: false,
        departures: departureResult.items,
        updates: new Map(updateResult.items.map((item) => [item.trip_id, item])),
        vehicles: new Map(vehicleResult.items.map((item) => [item.trip_id, item])),
        serviceDate: departureResult.service_date
      });
    } catch (err) {
      if (requestId !== stopScheduleRequestId.current) return;
      setStopSchedule({ stopId: stop.stop_id, loading: false, departures: [], updates: new Map(), vehicles: new Map() });
      setMessage(err instanceof Error ? err.message : 'Could not load stop timetable');
    }
  }

  async function selectStopAndFilterRoutes(stop: StopItem, source: StopDetailSource) {
    selectStop(stop, source);
    setStopSchedule({ stopId: stop.stop_id, loading: true, departures: [], updates: new Map(), vehicles: new Map() });
    try {
      const result = await routesOnStops([stop.stop_id]);
      const routeIds = result.items.map((route) => route.route_id);
      setStopRouteFilter({ stop, routeIds });
      void loadStopSchedule(stop, routeIds);
      if (source !== 'nearby') {
        setSelectedRoute((current) => (
          current && routeIds.includes(current.route_id)
            ? current
            : routeItems.find((route) => route.route_id === routeIds[0]) ?? result.items[0] ?? current
        ));
      }
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
            className={`route-card ${selectedRoute?.route_id === route.route_id ? 'active' : ''}`}
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
    <aside className="route-sidebar">
        <header className="product-header">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
          <div>
            <strong>AT Public Note</strong>
            <span>{feed?.feed_version ?? 'Feed loading'}</span>
          </div>
          <button
            className="language-toggle"
            onClick={() => setLanguage((current) => (current === 'en' ? 'mi' : 'en'))}
            title={t.otherLanguageName}
          >
            {language === 'en' ? 'MI' : 'EN'}
          </button>
        </header>

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
                className={`favourite-route-chip ${selectedRoute?.route_id === route.route_id ? 'active' : ''}`}
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
    </aside>
  );

  return (
    <main className="app-shell">
      <section className="map-workspace">
        <section className="map-stage">
          <div ref={mapNode} className="map-canvas" />
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
              selectedMapItem.type === 'route' ? (
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
  selectedRouteOnly: boolean;
  onSelectedRouteOnlyChange: (value: boolean) => void;
  onSelectRoute: (route: RouteItem, departure: DepartureItem) => void;
  onSelectVehicle: (vehicle: VehicleItem, departure: DepartureItem) => void;
  t: UiText;
}) {
  const stop = detail.item;
  const now = Date.now();
  const timetableRows = (schedule?.departures ?? [])
    .filter((departure) => !selectedRouteOnly || !selectedRoute || departure.route_id === selectedRoute.route_id)
    .map((departure) => {
      const route = routes.find((item) => item.route_id === departure.route_id);
      const update = schedule?.updates.get(departure.trip_id);
      const vehicle = schedule?.vehicles.get(departure.trip_id);
      const timing = adjustedDepartureTiming(departure, update, schedule?.serviceDate);
      return { departure, route, vehicle, timing };
    })
    .filter((row) => row.timing.epochMs == null || row.timing.epochMs >= now - 2 * 60 * 1000)
    .sort((a, b) => (a.timing.epochMs ?? Number.MAX_SAFE_INTEGER) - (b.timing.epochMs ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 8);

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
      <div className="stop-timetable" aria-label={t.upcomingTimetable}>
        {schedule?.loading && <p>{t.loadingUpcoming}</p>}
        {!schedule?.loading && timetableRows.length === 0 && <p>{t.noUpcoming}</p>}
        {timetableRows.map(({ departure, route, vehicle, timing }) => {
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

function vehicleLabel(vehicle: VehicleItem | undefined) {
  if (!vehicle) return 'No vehicle';
  if (vehicle.vehicle_label) return vehicle.vehicle_label;
  return vehicle.vehicle_id ? `Vehicle ${vehicle.vehicle_id}` : 'Vehicle assigned';
}

function vehicleIdentityKey(vehicle: VehicleItem) {
  const identity =
    vehicle.trip_id ||
    vehicle.vehicle_id ||
    vehicle.vehicle_label ||
    vehicle.vehicle_license_plate;
  return String(identity || '').trim();
}

function dedupeVehicleItems(items: VehicleItem[]) {
  const byIdentity = new Map<string, VehicleItem>();
  for (const item of items) {
    const key = vehicleIdentityKey(item);
    if (!key) continue;
    const existing = byIdentity.get(key);
    if (!existing || (item.timestamp ?? 0) >= (existing.timestamp ?? 0)) {
      byIdentity.set(key, item);
    }
  }
  return Array.from(byIdentity.values()).slice(0, 80);
}

function findMatchingVehicle(items: VehicleItem[], vehicle: VehicleItem) {
  const vehicleKey = vehicleIdentityKey(vehicle);
  if (vehicleKey) return items.find((item) => vehicleIdentityKey(item) === vehicleKey);
  return undefined;
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

function formatOccupancyStatus(status: string | number | null | undefined) {
  if (status == null || status === '') return '-';
  const labels: Record<string, string> = {
    '0': 'Empty',
    '1': 'Many seats available',
    '2': 'Few seats available',
    '3': 'Standing room only',
    '4': 'Very crowded',
    '5': 'Full',
    '6': 'Not accepting passengers',
    '7': 'Occupancy unavailable',
    '8': 'Not boardable',
    EMPTY: 'Empty',
    MANY_SEATS_AVAILABLE: 'Many seats available',
    FEW_SEATS_AVAILABLE: 'Few seats available',
    STANDING_ROOM_ONLY: 'Standing room only',
    CRUSHED_STANDING_ROOM_ONLY: 'Very crowded',
    FULL: 'Full',
    NOT_ACCEPTING_PASSENGERS: 'Not accepting passengers',
    NO_DATA_AVAILABLE: 'Occupancy unavailable',
    NOT_BOARDABLE: 'Not boardable'
  };
  const value = String(status);
  return labels[value] ?? value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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
