import type { LineString } from 'geojson';

export type User = {
  id: number;
  email: string;
};

export type AuthResponse = {
  access_token: string;
  token_type: string;
  user: User;
};

export type FeedResponse = {
  feed_version: string;
  source_url?: string | null;
  imported_at?: string;
  counts?: Record<string, number>;
};

export type RouteItem = {
  route_id: string;
  agency_id?: string | null;
  route_short_name: string;
  route_long_name: string;
  route_type: number;
  route_color: string | null;
  route_text_color: string | null;
};

export type StopItem = {
  stop_id: string;
  stop_code?: string | null;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  platform_code?: string | null;
  stop_sequence?: number | null;
  distance_m?: number | null;
};

export type RouteShape = {
  shape_id: string;
  direction_id?: number | null;
  representative_trip_id?: string | null;
  trip_headsign?: string | null;
  geometry: LineString;
};

export type RouteDirection = {
  direction_id: number | null;
  representative_trip_id: string;
  trip_headsign?: string | null;
  stops: StopItem[];
};

export type AlertItem = {
  alert_id: string;
  route_ids?: string[];
  stop_ids?: string[];
  header: string | null;
  description: string | null;
  cause: string | null;
  effect: string | null;
  severity_level: string | null;
};

export type VehicleItem = {
  vehicle_id: string;
  vehicle_label?: string | null;
  vehicle_license_plate?: string | null;
  route_id: string;
  trip_id: string;
  direction_id?: number | null;
  schedule_relationship?: string | null;
  occupancy_status?: string | number | null;
  position: {
    latitude: number | null;
    longitude: number | null;
    bearing: number | null;
    speed?: number | null;
  };
  timestamp?: number | null;
};

export type DepartureItem = {
  trip_id: string;
  route_id: string;
  stop_id: string;
  stop_sequence?: number | null;
  direction_id?: number | null;
  trip_headsign: string | null;
  scheduled_departure_time: string;
  scheduled_departure_seconds: number;
  stop_name?: string;
};

export type RouteTripItem = {
  trip_id: string;
  route_id: string;
  direction_id?: number | null;
  trip_headsign?: string | null;
  scheduled_departure_seconds?: number | null;
};

export type RealtimeTimeEvent = {
  delay?: number | null;
  time?: number | null;
  uncertainty?: number | null;
};

export type TripUpdateItem = {
  trip_id: string;
  route_id: string;
  direction_id?: number | null;
  delay?: number | null;
  stop_time_updates: {
    stop_id?: string | null;
    stop_sequence?: number | null;
    arrival?: RealtimeTimeEvent | null;
    departure?: RealtimeTimeEvent | null;
  }[];
};

export type RealtimeRefreshEvent = {
  event_types: string[];
  feed_version?: string | null;
  generated_at?: string | null;
  route_ids?: string[];
  trip_ids?: string[];
};

export type CacheMeta = {
  status: 'hit' | 'miss' | string;
  cell?: string;
};

export type PlaceCandidate = {
  id: string;
  name: string;
  display_name: string;
  secondary_text: string;
  latitude: number;
  longitude: number;
  category: string;
  type: string;
  bounding_box?: number[] | null;
  attribution: string;
};

export type JourneyEndpoint = {
  place_id?: string | null;
  name: string;
  latitude: number;
  longitude: number;
  confirmed: boolean;
};

export type JourneyPoint = {
  name: string;
  latitude: number;
  longitude: number;
  stop_id?: string | null;
  platform_code?: string | null;
};

export type TransitJourneyLeg = {
  type: 'transit';
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: number;
  route_color?: string | null;
  route_text_color?: string | null;
  trip_id: string;
  direction_id?: number | null;
  shape_id?: string | null;
  headsign?: string | null;
  service_date: string;
  from: JourneyPoint;
  to: JourneyPoint;
  scheduled_departure: string;
  scheduled_arrival: string;
  realtime?: TripUpdateItem | null;
  alerts?: AlertItem[];
};

export type JourneyOption = {
  id: string;
  departure_time: string;
  duration_seconds: number;
  transfers: number;
  legs: TransitJourneyLeg[];
};

export type JourneyPlanResponse = {
  feed_version: string;
  service_date: string;
  status: 'ok' | 'no_journey';
  realtime_status: 'current' | 'unavailable' | 'mismatched';
  realtime_generated_at?: string | null;
  options: JourneyOption[];
};
