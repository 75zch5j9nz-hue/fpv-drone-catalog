'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_URL || '';

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

type StoredFile = { id: number; role: string; original_filename: string | null; size_bytes: number };
type Snapshot = {
  id: number; name: string; slug: string;
  betaflight_version: string | null;
  notes: string | null;
  is_current: boolean;
  is_known_good: boolean;
  created_at: string;
  files: StoredFile[];
};
type Drone = {
  id: number; name: string; slug: string; status: string;
  snapshots: Snapshot[];
};

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  flyable:        { color: '#4fc38a', bg: 'rgba(79,195,138,0.15)' },
  needs_repair:   { color: '#f0a830', bg: 'rgba(240,168,48,0.15)' },
  grounded_crash: { color: '#e04040', bg: 'rgba(224,64,64,0.15)' },
  in_build:       { color: '#60a0f0', bg: 'rgba(96,160,240,0.15)' },
  retired:        { color: '#7a8599', bg: 'rgba(122,133,153,0.15)' },
  for_parts:      { color: '#7a8599', bg: 'rgba(122,133,153,0.12)' },
};
const STATUS_LABELS: Record<string, string> = {
  flyable: 'Flyable', needs_repair: 'Needs repair', grounded_crash: 'Crashed',
  in_build: 'In build', retired: 'Retired', for_parts: 'For parts',
};

function formatDate(v: string) {
  return new Date(v).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function SnapshotsPage() {
  const pathname = usePathname();
  const [drones, setDrones] = useState<Drone[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterDrone, setFilterDrone] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);

  useEffect(() => {
    apiFetch<Drone[]>('/api/drones')
      .then(d => { setDrones(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const totalSnaps = drones.reduce((n, d) => n + d.snapshots.length, 0);

  const filtered = drones.filter(d => {
    if (!showEmpty && d.snapshots.length === 0) return false;
    if (filterDrone && !d.name.toLowerCase().includes(filterDrone.toLowerCase())) return false;
    return true;
  });

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="badge-row">
          <span className="badge warm">Betaflight Snapshots</span>
          <span className="badge">{totalSnaps} snapshots</span>
          <span className="badge">{drones.length} drones</span>
        </div>
        <h1>Snapshot Archive</h1>
        <p>All Betaflight CLI exports, firmware versions, and known-good configs across every drone in your fleet.</p>
      </section>

      <nav className="subnav" aria-label="Main navigation">
        <Link className="subnav-link" href="/">Overview</Link>
        <Link className="subnav-link" href="/drones">Drones</Link>
        <Link className="subnav-link" href="/batteries">Batteries</Link>
        <Link className="subnav-link" href="/catalogue">Catalogue</Link>
        <Link className={`subnav-link${pathname === '/snapshots' ? ' active' : ''}`} href="/snapshots">Snapshots</Link>
      </nav>

      <div className="snaps-page">
        <div className="filter-bar">
          <input
            type="text"
            placeholder="Filter by drone name…"
            value={filterDrone}
            onChange={e => setFilterDrone(e.target.value)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '0.83rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showEmpty}
              onChange={e => setShowEmpty(e.target.checked)}
            />
            Show drones without snapshots
          </label>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {filtered.length} drone{filtered.length !== 1 ? 's' : ''} · {totalSnaps} snapshots
          </span>
        </div>

        {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

        {!loading && filtered.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>
            {drones.length === 0
              ? 'No drones yet. Add one on the Drones page.'
              : 'No drones with snapshots found.'}
          </p>
        )}

        {filtered.map(drone => (
          <div key={drone.id} className="snaps-drone-group">
            <div className="snaps-drone-header">
              <span className="snaps-drone-name">{drone.name}</span>
              <span
                className="recent-meta"
                style={{
                  background: STATUS_COLORS[drone.status]?.bg ?? 'var(--surface2)',
                  color: STATUS_COLORS[drone.status]?.color ?? 'var(--text-muted)',
                }}
              >
                {STATUS_LABELS[drone.status] ?? drone.status}
              </span>
              <span className="snaps-count">
                {drone.snapshots.length} snapshot{drone.snapshots.length !== 1 ? 's' : ''}
              </span>
            </div>

            {drone.snapshots.length === 0 ? (
              <div className="snap-row" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No snapshots yet
              </div>
            ) : (
              <div className="snaps-list">
                {drone.snapshots.map(snap => (
                  <div key={snap.id} className="snap-row">
                    <span className="snap-row-name">{snap.name}</span>
                    {snap.is_current && <span className="snap-badge snap-badge-current">current</span>}
                    {snap.is_known_good && <span className="snap-badge snap-badge-good">known-good</span>}
                    {snap.betaflight_version && (
                      <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                        BF {snap.betaflight_version}
                      </span>
                    )}
                    <span className="snap-date">{formatDate(snap.created_at)}</span>
                    <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                      {snap.files.length} file{snap.files.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
