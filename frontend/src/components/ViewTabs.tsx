import { Map, Route } from 'lucide-react';

type Props = {
  active: 'map' | 'journey';
  onMap?: () => void;
  onJourney?: () => void;
};

export function ViewTabs({ active, onMap, onJourney }: Props) {
  return (
    <nav className="view-tabs" aria-label="Application view">
      <button
        type="button"
        className={active === 'map' ? 'active' : ''}
        aria-current={active === 'map' ? 'page' : undefined}
        onClick={active === 'map' ? undefined : onMap}
      >
        <Map size={15} />
        <span>Map</span>
      </button>
      <button
        type="button"
        className={active === 'journey' ? 'active' : ''}
        aria-current={active === 'journey' ? 'page' : undefined}
        disabled={!onJourney && active !== 'journey'}
        onClick={active === 'journey' ? undefined : onJourney}
      >
        <Route size={15} />
        <span>Journey</span>
      </button>
    </nav>
  );
}
