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
