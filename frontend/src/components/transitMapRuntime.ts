import maplibregl from 'maplibre-gl';

export const AUCKLAND_CENTER: [number, number] = [174.7633, -36.8485];

const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL?.trim();
export const DEFAULT_TRANSIT_MAP_STYLE: maplibregl.StyleSpecification = {
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
  layers: [{ id: 'openstreetmap-basemap', type: 'raster', source: 'openstreetmap-tiles' }]
};

const AT_ATTRIBUTION = 'Public Transport Data &copy; <a href="https://at.govt.nz/about-us/at-data-sources/general-transit-feed-specification">Auckland Transport</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)';

export function createTransitMap(container: HTMLElement): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: MAP_STYLE_URL || DEFAULT_TRANSIT_MAP_STYLE,
    center: AUCKLAND_CENTER,
    zoom: 10.7,
    attributionControl: false
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: AT_ATTRIBUTION }), 'bottom-right');
  return map;
}

export function observeTransitMapReady(map: maplibregl.Map, onReady: () => void): () => void {
  const markReady = () => {
    if (map.isStyleLoaded()) onReady();
  };
  map.on('load', markReady);
  map.on('styledata', markReady);
  map.on('idle', markReady);
  return () => {
    map.off('load', markReady);
    map.off('styledata', markReady);
    map.off('idle', markReady);
  };
}
