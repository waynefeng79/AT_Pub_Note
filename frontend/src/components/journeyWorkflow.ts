import type { JourneyEndpoint, JourneyOption, PlaceCandidate } from '../types/domain';

export type EndpointField = {
  query: string;
  selected: JourneyEndpoint | null;
  candidates: PlaceCandidate[];
  searching: boolean;
  error: string | null;
};

export const emptyEndpointField = (): EndpointField => ({ query: '', selected: null, candidates: [], searching: false, error: null });

export function invalidateEndpoint(field: EndpointField, query: string): EndpointField {
  return { ...field, query, selected: null, candidates: [], error: null };
}

export function endpointFromCandidate(candidate: PlaceCandidate): JourneyEndpoint {
  return {
    place_id: candidate.id,
    name: candidate.display_name,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    confirmed: true
  };
}

export function selectEndpointCandidate(field: EndpointField, candidate: PlaceCandidate): EndpointField {
  return { ...field, query: candidate.display_name, selected: endpointFromCandidate(candidate), candidates: [], error: null };
}

export function confirmCoordinateEndpoint(field: EndpointField, longitude: number, latitude: number): EndpointField {
  const name = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  return { ...field, query: name, selected: { name, latitude, longitude, confirmed: true }, candidates: [], error: null };
}

export function applyReverseLabel(
  field: EndpointField,
  candidate: PlaceCandidate,
  longitude: number,
  latitude: number
): EndpointField {
  if (!field.selected || field.selected.longitude !== longitude || field.selected.latitude !== latitude) return field;
  return {
    ...field,
    query: candidate.display_name,
    selected: {
      place_id: candidate.id,
      name: candidate.display_name,
      longitude,
      latitude,
      confirmed: true
    },
    candidates: [],
    error: null
  };
}

export function replaceItinerary(_current: JourneyOption | null, next: JourneyOption): JourneyOption {
  return next;
}
