import { Bus, ShipWheel, TrainFront } from 'lucide-react';

export function RouteModeIcon({ type, size = 16 }: { type: number; size?: number }) {
  if (type === 2) return <TrainFront size={size} />;
  if (type === 4) return <ShipWheel size={size} />;
  return <Bus size={size} />;
}
