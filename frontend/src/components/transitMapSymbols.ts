import type maplibregl from 'maplibre-gl';
import type { Feature, Point } from 'geojson';
import type { RouteItem, VehicleItem } from '../types/domain';
import { vehicleIdentityKey } from './transitMapModel';

export function routeColour(route: Pick<RouteItem, 'route_color'>): string {
  return `#${route.route_color?.replace('#', '') || '0f766e'}`;
}

function vehicleModeKey(routeType: number | null | undefined) {
  if (routeType === 2) return 'train';
  if (routeType === 4) return 'ferry';
  return 'bus';
}

function isExtraServiceVehicle(vehicle: VehicleItem) {
  return ['ADDED', 'REPLACEMENT', 'DUPLICATED'].includes(vehicle.schedule_relationship ?? '');
}

function vehicleImageId(route: RouteItem | null, extraService = false) {
  const routeColor = route ? routeColour(route).replace(/[^a-zA-Z0-9]/g, '') : '0f766e';
  return `vehicle-${vehicleModeKey(route?.route_type)}-${routeColor}${extraService ? '-extra' : ''}`;
}

export function ensureVehicleImage(mapInstance: maplibregl.Map, route: RouteItem | null, extraService = false) {
  const imageId = vehicleImageId(route, extraService);
  if (mapInstance.hasImage(imageId)) return imageId;

  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return imageId;

  const routeColor = route ? routeColour(route) : '#0f766e';
  context.clearRect(0, 0, size, size);
  context.fillStyle = routeColor;
  context.strokeStyle = '#ffffff';
  context.lineWidth = 4;
  context.beginPath();
  context.arc(size / 2, size / 2, 18, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  if (extraService) {
    context.strokeStyle = '#f59e0b';
    context.lineWidth = 3;
    context.beginPath();
    context.arc(size / 2, size / 2, 20, 0, Math.PI * 2);
    context.stroke();
  }

  context.fillStyle = '#ffffff';
  context.strokeStyle = '#ffffff';
  context.lineWidth = 2.2;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  const mode = vehicleModeKey(route?.route_type);
  if (mode === 'train') {
    context.fillRect(14, 11, 16, 18);
    context.fillStyle = routeColor;
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
    context.fillStyle = routeColor;
    context.fillRect(19, 17, 3, 3);
    context.fillRect(24, 17, 3, 3);
    context.fillStyle = '#ffffff';
  } else {
    context.fillRect(12, 13, 20, 16);
    context.fillStyle = routeColor;
    context.fillRect(15, 16, 5, 5);
    context.fillRect(24, 16, 5, 5);
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.arc(17, 31, 2.2, 0, Math.PI * 2);
    context.arc(27, 31, 2.2, 0, Math.PI * 2);
    context.fill();
  }

  if (extraService) {
    context.fillStyle = '#f59e0b';
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(32, 12, 7, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.beginPath();
    context.moveTo(32, 8.5);
    context.lineTo(32, 15.5);
    context.moveTo(28.5, 12);
    context.lineTo(35.5, 12);
    context.stroke();
  }

  mapInstance.addImage(imageId, context.getImageData(0, 0, size, size), { pixelRatio: 2 });
  return imageId;
}

export function vehicleFeatures(
  items: VehicleItem[],
  routeLookup: Map<string, RouteItem>,
  fallbackRoute: RouteItem | null = null
): Feature<Point>[] {
  return items
    .filter((item) => item.position.latitude != null && item.position.longitude != null)
    .map((item) => {
      const route = routeLookup.get(item.route_id) ?? fallbackRoute;
      return {
        type: 'Feature',
        properties: {
          vehicle_key: vehicleIdentityKey(item),
          id: item.vehicle_id,
          trip_id: item.trip_id,
          bearing: item.position.bearing ?? 0,
          mode_image: vehicleImageId(route, isExtraServiceVehicle(item))
        },
        geometry: { type: 'Point', coordinates: [item.position.longitude!, item.position.latitude!] }
      };
    });
}
