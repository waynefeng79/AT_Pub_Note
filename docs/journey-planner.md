# Journey planner operations

## Public Nominatim obligations

The first-stage geocoder proxies explicit user searches through the backend. It does not call Nominatim per keystroke. Before production, set a monitored operator contact:

```env
NOMINATIM_BASE_URL=https://nominatim.openstreetmap.org
NOMINATIM_PUBLIC_POLICY=true
NOMINATIM_USER_AGENT=AT-Public-Note/1.0
NOMINATIM_CONTACT=transit-ops@example.org
```

The deployment must continue to follow the current [OSMF Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). At the time of implementation it requires no heavy use (an aggregate maximum of one request per second), an identifying User-Agent or Referer, visible attribution, switchable providers, and prohibits client-side autocomplete. It also warns against submitting personal or confidential data. The application enforces a Redis-backed aggregate permit, caches positive/empty/reverse results, only searches on explicit Search/Enter, and displays OpenStreetMap attribution. Policy can change without notice, so review it before each rollout.

The existing raster map remains `https://tile.openstreetmap.org/{z}/{x}/{y}.png`; Nominatim supplies place search only. Keep visible `© OpenStreetMap contributors` tile attribution and review the separate [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/) when changing map traffic or hosting.

## Moving to private Nominatim

No frontend or application API change is required. Change the backend provider settings:

```env
NOMINATIM_BASE_URL=https://nominatim.internal.example
NOMINATIM_PUBLIC_POLICY=false
NOMINATIM_USER_AGENT=AT-Public-Note/1.0
NOMINATIM_CONTACT=transit-ops@example.org
```

Keep caching enabled to protect the private service. `NOMINATIM_PUBLIC_POLICY=false` disables the public one-request-per-second permit; capacity controls for the private deployment should be enforced at its load balancer or added as a separate policy profile. Do not point the frontend directly at either service.

## Planner tuning and sizing

The planner finds scheduled route chains with up to two transfers. It considers a bounded set of source/destination-near stops, and transfers only at the same stop or among platforms sharing a GTFS parent station. Every next leg must depart after the preceding scheduled arrival plus the configured transfer buffer.

The displayed estimate is in-vehicle time only: the sum of scheduled boarding-to-alighting durations. It does not predict arrival time or include initial wait, endpoint walking, or transfer movement.

Measure representative route-chain requests on the target ARM EC2 before increasing worker count; development-host timings are not production capacity guarantees.

Each Uvicorn worker owns its own immutable timetable index. Begin a planner-enabled deployment with `WEB_CONCURRENCY=1`, measure the index logs against the live feed, and add workers only when memory headroom supports one warm index per worker. A production release gate should run direct, one-transfer, two-transfer, missed-transfer, and post-midnight searches.

## Metrics and privacy

Structured application logs expose:

- geocoder cache hit/miss and result count;
- public permit wait/outcome and upstream operation/status/latency;
- planner index build duration and estimated bytes;
- planner index build and final request duration/result count;
- frontend scheduled/realtime layer degradation in the browser console.

Geocoder logs intentionally omit query text, coordinates, cache keys, and normalized candidates. Planner logs omit origin/destination names and coordinates. Do not add raw journey location history to routine logs.

## Rollout and rollback

1. Configure operator contact, Redis, and the public/private policy profile.
2. Apply the normal database migrations and import the active GTFS feed.
3. Run backend/integration tests and the live-feed benchmark with `JOURNEY_PLANNER_ENABLED=true` while keeping frontend navigation off with `VITE_JOURNEY_PLANNER_ENABLED=false`.
4. Exercise ambiguous search, no-result, direct, one-transfer, two-transfer, post-midnight, realtime-unavailable, and expired-feed cases.
5. Rebuild the frontend with `VITE_JOURNEY_PLANNER_ENABLED=true` to enable navigation.

Rollback navigation by rebuilding with `VITE_JOURNEY_PLANNER_ENABLED=false`. Disable the API with `JOURNEY_PLANNER_ENABLED=false` if required. The existing network map, GTFS import, and realtime APIs continue to operate.
