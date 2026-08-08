import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownUp, Clock3, Loader2, MapPin, Search, TriangleAlert } from 'lucide-react';
import { planJourney, searchPlaces } from '../api/client';
import type { JourneyEndpoint, JourneyOption, PlaceCandidate } from '../types/domain';
import {
  emptyEndpointField,
  invalidateEndpoint,
  selectEndpointCandidate,
  type EndpointField
} from './journeyWorkflow';

export type EndpointRole = 'origin' | 'destination';

export type JourneyPlanSelection = {
  feedVersion: string;
  option: JourneyOption;
  origin: JourneyEndpoint;
  destination: JourneyEndpoint;
  realtimeStatus: string;
};

type Props = {
  onSelectJourney: (selection: JourneyPlanSelection) => Promise<void> | void;
  onJourneyOptionsChange: (options: JourneyPlanSelection[]) => void;
};

function EndpointSearch({
  role,
  label,
  field,
  onChange,
  onSearch,
  onSelect,
  idPrefix = 'journey'
}: {
  role: EndpointRole;
  label: string;
  field: EndpointField;
  onChange: (value: string) => void;
  onSearch: () => void;
  onSelect: (candidate: PlaceCandidate) => void;
  idPrefix?: string;
}) {
  return (
    <div className="journey-endpoint-field">
      <label htmlFor={`${idPrefix}-${role}`}>{label}</label>
      <div className="journey-search-row">
        <input
          id={`${idPrefix}-${role}`}
          value={field.query}
          placeholder={role === 'origin' ? 'Choose starting place' : 'Where do you want to go?'}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSearch();
            }
          }}
          aria-invalid={Boolean(field.error)}
        />
        <button type="button" className="icon-button" onClick={onSearch} disabled={field.searching} aria-label={`Search ${label}`}>
          {field.searching ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
        </button>
      </div>
      {field.selected && <div className="journey-confirmed"><MapPin size={14} /> Confirmed: {field.selected.name}</div>}
      {field.error && <div className="field-error">{field.error}</div>}
      {field.candidates.length > 0 && (
        <div className="place-candidates" role="listbox" aria-label={`${label} matches`}>
          <p>{field.candidates.length > 1 ? 'Choose the intended location' : 'Confirm this location'}</p>
          {field.candidates.map((candidate) => (
            <button key={candidate.id} type="button" role="option" onClick={() => onSelect(candidate)}>
              <strong>{candidate.name}</strong>
              <span>{candidate.secondary_text || candidate.display_name}</span>
              <small>{candidate.category || candidate.type}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function currentDeparture() {
  const date = new Date();
  date.setSeconds(0, 0);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function JourneyPlannerControls({ onSelectJourney, onJourneyOptionsChange }: Props) {
  const [fields, setFields] = useState<Record<EndpointRole, EndpointField>>({ origin: emptyEndpointField(), destination: emptyEndpointField() });
  const [departure, setDeparture] = useState(currentDeparture);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [dockTarget, setDockTarget] = useState<HTMLElement | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [feedVersion, setFeedVersion] = useState<string | null>(null);
  const [planRealtimeStatus, setPlanRealtimeStatus] = useState('unavailable');
  const [plannedEndpoints, setPlannedEndpoints] = useState<{ origin: JourneyEndpoint; destination: JourneyEndpoint } | null>(null);
  const endpointRequests = useRef<Record<EndpointRole, { generation: number; search: AbortController | null; reverse: AbortController | null }>>({
    origin: { generation: 0, search: null, reverse: null },
    destination: { generation: 0, search: null, reverse: null }
  });
  const planRequest = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const automaticallyPlanned = useRef('');

  const updateField = (role: EndpointRole, update: Partial<EndpointField>) => {
    setFields((current) => ({ ...current, [role]: { ...current[role], ...update } }));
  };

  const cancelEndpointRequests = (role: EndpointRole) => {
    const request = endpointRequests.current[role];
    request.generation += 1;
    request.search?.abort();
    request.reverse?.abort();
    request.search = null;
    request.reverse = null;
  };

  const invalidateResults = () => {
    planRequest.current.generation += 1;
    planRequest.current.controller?.abort();
    planRequest.current.controller = null;
    setPlanning(false);
    setPlanError(null);
    setFeedVersion(null);
    onJourneyOptionsChange([]);
  };

  const changeQuery = (role: EndpointRole, query: string) => {
    cancelEndpointRequests(role);
    invalidateResults();
    setFields((current) => ({ ...current, [role]: invalidateEndpoint(current[role], query) }));
  };

  const runSearch = async (role: EndpointRole) => {
    const query = fields[role].query.trim();
    if (query.length < 3) {
      updateField(role, { error: 'Enter at least 3 characters.', candidates: [] });
      return;
    }
    invalidateResults();
    const request = endpointRequests.current[role];
    request.search?.abort();
    const generation = ++request.generation;
    const controller = new AbortController();
    request.search = controller;
    updateField(role, { searching: true, error: null, selected: null });
    try {
      const response = await searchPlaces(query, 8, controller.signal);
      if (generation !== request.generation) return;
      setFields((current) => current[role].query.trim() !== query ? current : ({
        ...current,
        [role]: {
          ...current[role],
          candidates: response.candidates,
          error: response.candidates.length ? null : 'No Auckland locations matched. Try a street, suburb, or landmark.'
        }
      }));
    } catch (error) {
      if (controller.signal.aborted || generation !== request.generation) return;
      updateField(role, { error: error instanceof Error ? error.message : 'Location search is unavailable.' });
    } finally {
      if (generation === request.generation) {
        request.search = null;
        updateField(role, { searching: false });
      }
    }
  };

  const chooseCandidate = (role: EndpointRole, candidate: PlaceCandidate) => {
    cancelEndpointRequests(role);
    invalidateResults();
    automaticallyPlanned.current = '';
    setFields((current) => ({ ...current, [role]: selectEndpointCandidate(current[role], candidate) }));
  };

  const chooseCurrentPosition = (longitude: number, latitude: number) => {
    cancelEndpointRequests('origin');
    invalidateResults();
    setFields((current) => ({
      ...current,
      origin: {
        ...current.origin,
        query: 'My position',
        selected: { name: 'My position', longitude, latitude, confirmed: true },
        candidates: [],
        error: null
      }
    }));
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      updateField('origin', { error: 'Current location is unavailable in this browser.' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        chooseCurrentPosition(coords.longitude, coords.latitude);
      },
      () => {
        updateField('origin', { error: 'Could not get your current location. Check browser location permission.' });
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 }
    );
  };

  const applyOption = async (
    option: JourneyOption,
    appliedFeedVersion = feedVersion,
    endpoints = plannedEndpoints,
    realtimeStatus = planRealtimeStatus
  ) => {
    if (!appliedFeedVersion || !endpoints) return;
    setPlanError(null);
    try {
      await onSelectJourney({
        feedVersion: appliedFeedVersion,
        option,
        origin: endpoints.origin,
        destination: endpoints.destination,
        realtimeStatus
      });
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : 'The selected journey could not be shown.');
    }
  };

  const submitPlan = async (origin = fields.origin.selected, destination = fields.destination.selected, plannedDeparture = departure) => {
    if (!origin || !destination) {
      setPlanError('Allow location access, then choose a destination.');
      return;
    }
    planRequest.current.controller?.abort();
    const requestGeneration = ++planRequest.current.generation;
    const controller = new AbortController();
    planRequest.current.controller = controller;
    setPlanning(true);
    setPlanError(null);
    try {
      const result = await planJourney(origin, destination, new Date(plannedDeparture).toISOString(), 5, controller.signal);
      if (requestGeneration !== planRequest.current.generation) return;
      const endpoints = { origin, destination };
      setFeedVersion(result.feed_version);
      setPlanRealtimeStatus(result.realtime_status);
      setPlannedEndpoints(endpoints);
      onJourneyOptionsChange(result.options.map((option) => ({
        feedVersion: result.feed_version,
        option,
        origin,
        destination,
        realtimeStatus: result.realtime_status
      })));
      if (!result.options.length) {
        setPlanError('No transit journey was found near that time. Try another departure time or nearby locations.');
        return;
      }
      await applyOption(result.options[0], result.feed_version, endpoints, result.realtime_status);
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== planRequest.current.generation) return;
      setPlanError(error instanceof Error ? error.message : 'Journey planning is temporarily unavailable.');
    } finally {
      if (requestGeneration === planRequest.current.generation) {
        planRequest.current.controller = null;
        setPlanning(false);
      }
    }
  };

  useEffect(() => {
    useCurrentLocation();
  }, []);

  useEffect(() => {
    const origin = fields.origin.selected;
    const destination = fields.destination.selected;
    if (!origin || !destination) return;
    const signature = `${origin.latitude},${origin.longitude}:${destination.latitude},${destination.longitude}`;
    if (automaticallyPlanned.current === signature) return;
    automaticallyPlanned.current = signature;
    void submitPlan(origin, destination);
  }, [fields.origin.selected, fields.destination.selected]);

  const swapEndpoints = () => {
    const origin = fields.origin;
    const destination = fields.destination;
    if (!origin.selected || !destination.selected) return;
    invalidateResults();
    setFields({
      origin: { ...destination, candidates: [] },
      destination: { ...origin, candidates: [] }
    });
  };

  useEffect(() => () => {
    for (const request of Object.values(endpointRequests.current)) {
      request.search?.abort();
      request.reverse?.abort();
    }
    planRequest.current.controller?.abort();
  }, []);

  useLayoutEffect(() => {
    const nextTarget = plannedEndpoints ? document.getElementById('journey-planner-dock-controls') : null;
    setDockTarget((current) => current === nextTarget ? current : nextTarget);
  });

  const destinationControl = <EndpointSearch
    role="destination"
    label="Destination"
    field={fields.destination}
    onChange={(value) => changeQuery('destination', value)}
    onSearch={() => void runSearch('destination')}
    onSelect={(candidate) => chooseCandidate('destination', candidate)}
  />;
  return <>
    <section className="journey-sidebar-form">
      {destinationControl}
      {planning && <small className="journey-plan-requirement"><Loader2 className="spin" size={13} /> Planning from your current location…</small>}
      {!planning && !fields.origin.selected && <small className="journey-plan-requirement">Allow location access to plan from your current location.</small>}
      {!dockTarget && planError && <div className="journey-message error"><TriangleAlert size={16} />{planError}</div>}
      <small className="geocoder-attribution">Location results © OpenStreetMap contributors</small>
    </section>
    {dockTarget && createPortal(
      <section className="journey-dock-controls">
        <div className="journey-dock-endpoints">
          <EndpointSearch
            role="origin"
            label="From"
            idPrefix="journey-dock"
            field={fields.origin}
            onChange={(value) => changeQuery('origin', value)}
            onSearch={() => void runSearch('origin')}
            onSelect={(candidate) => chooseCandidate('origin', candidate)}
          />
          <button type="button" className="journey-swap-button" onClick={swapEndpoints} aria-label="Swap source and destination" title="Swap source and destination"><ArrowDownUp size={15} /></button>
          <button type="button" className="journey-time-button" onClick={() => setTimePickerOpen((open) => !open)} aria-label="Choose departure time" title="Choose departure time"><Clock3 size={15} /></button>
          <EndpointSearch
            role="destination"
            label="To"
            idPrefix="journey-dock"
            field={fields.destination}
            onChange={(value) => changeQuery('destination', value)}
            onSearch={() => void runSearch('destination')}
            onSelect={(candidate) => chooseCandidate('destination', candidate)}
          />
        </div>
        {timePickerOpen && <label className="journey-time-picker">Leave at <input type="datetime-local" value={departure} onChange={(event) => { const value = event.target.value; setDeparture(value); setTimePickerOpen(false); void submitPlan(fields.origin.selected, fields.destination.selected, value); }} /></label>}
        {planError && <div className="journey-message error"><TriangleAlert size={16} />{planError}</div>}
      </section>,
      dockTarget
    )}
  </>;
}
