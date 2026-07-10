export function StatusPill({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn'; children: React.ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}
