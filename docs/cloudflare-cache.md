# Cloudflare Cache Configuration

This project has two different Cloudflare cache concerns:

- Cloudflare Pages serves the frontend static files.
- The backend API is proxied through Cloudflare for HTTPS and edge caching of public static GTFS endpoints.

Do not use a broad "cache everything" rule for the whole backend hostname. Realtime, auth, timetable, favourite route, nearby stop, and SSE requests must remain uncached.

## Frontend Pages

Cloudflare Pages can apply custom headers from a `_headers` file placed in the deployed static asset directory. For this Vite app, create `frontend/public/_headers` if you want explicit browser cache headers:

```text
/*
  Cache-Control: public, max-age=0, must-revalidate

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/favicon.svg
  Cache-Control: public, max-age=3600
```

Why:

- `index.html` should revalidate, because it points to the current hashed JS/CSS files.
- `/assets/*` files are fingerprinted by Vite and safe to cache for one year.
- `favicon.svg` is not fingerprinted, so keep its browser TTL modest while the icon is still changing.

## Backend Cache Rules

Create the following Cloudflare cache rules on the backend/API hostname, for example `api.yuyuw.xyz`.

### Rule 1: Bypass Dynamic API

Expression:

```text
(http.host eq "api.yuyuw.xyz" and starts_with(http.request.uri.path, "/api/auth/"))
or (http.host eq "api.yuyuw.xyz" and starts_with(http.request.uri.path, "/api/app/"))
or (http.host eq "api.yuyuw.xyz" and starts_with(http.request.uri.path, "/api/discovery/"))
or (http.host eq "api.yuyuw.xyz" and starts_with(http.request.uri.path, "/api/timetable/"))
or (http.host eq "api.yuyuw.xyz" and starts_with(http.request.uri.path, "/api/realtime/"))
```

Settings:

```text
Cache eligibility: Bypass cache
```

Place this rule above any static API cache rule.

### Rule 2: Cache Static GTFS API

Expression:

```text
http.host eq "api.yuyuw.xyz"
and http.request.method eq "GET"
and starts_with(http.request.uri.path, "/api/static/")
```

Settings:

```text
Cache eligibility: Eligible for cache
Edge TTL: Respect origin
Browser TTL: Respect origin
Cache key: default, or custom key including path + query string + Accept-Encoding
```

The backend already sends the intended `Cache-Control` headers:

- `/api/static/v1/feed`: `public, max-age=60, stale-while-revalidate=300`
- Versioned static feed endpoints: `public, max-age=86400, immutable`

Keep query strings in the cache key because route lists and shapes can use query parameters such as `direction_id`, `route_type`, `limit`, `offset`, and `search`.

Do not include these in a custom cache key:

- `Authorization`
- `Cookie`
- `User-Agent`

## Purging

The active pointer `/api/static/v1/feed` has a short TTL and usually does not need a manual purge. If you need immediate feed-switch propagation, purge only that URL:

```text
https://api.yuyuw.xyz/api/static/v1/feed
```

Versioned feed URLs are immutable. Do not purge them during normal operations.

## Verification

Check static cache behavior:

```bash
curl -I https://api.yuyuw.xyz/api/static/v1/feed
curl -I "https://api.yuyuw.xyz/api/static/v1/feeds/<feed-version>/routes"
```

Expected:

- `Cache-Control` is public on static endpoints.
- `CF-Cache-Status` is usually `MISS` on the first request and `HIT` or `REVALIDATED` after Cloudflare has cached the response.

Check dynamic bypass behavior:

```bash
curl -I https://api.yuyuw.xyz/api/realtime/v1/stream
```

Expected:

- `Cache-Control: no-store`
- no Cloudflare cache hit

## References

- Cloudflare Pages custom headers: <https://developers.cloudflare.com/pages/configuration/headers/>
- Cloudflare Cache Rules: <https://developers.cloudflare.com/cache/how-to/cache-rules/>
- Cloudflare Edge and Browser Cache TTL: <https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/>
