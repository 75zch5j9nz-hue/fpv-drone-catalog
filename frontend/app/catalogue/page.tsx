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

type Manufacturer = { id: number; name: string; slug: string; website: string | null };
type ProductVariant = { id: number; name: string; slug: string; specs: string | null; is_active: boolean };
type CatalogueProduct = {
  id: number; slug: string; name: string; component_role: string;
  tags: string | null; image_url: string | null; is_active: boolean;
  manufacturer: Manufacturer | null;
  category: { id: number; name: string; slug: string; component_role: string } | null;
  variants: ProductVariant[];
};

const ROLE_LABELS: Record<string, string> = {
  FRAME: 'Frame', FLIGHT_CONTROLLER: 'Flight Controller', ESC: 'ESC',
  FC_ESC_STACK: 'FC + ESC Stack', AIO_BOARD: 'AIO Board', MOTOR: 'Motor',
  PROPELLER: 'Propeller', RECEIVER: 'Receiver', VTX_VIDEO_UNIT: 'VTX / Video',
  CAMERA: 'Camera', ANTENNA: 'Antenna', GPS: 'GPS', BATTERY: 'Battery',
  ACCESSORY: 'Accessory', OTHER: 'Other',
};

export default function CataloguePage() {
  const pathname = usePathname();
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [filterMfr, setFilterMfr] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<Manufacturer[]>('/api/manufacturers'),
      apiFetch<CatalogueProduct[]>('/api/products'),
    ]).then(([mfrs, prods]) => {
      setManufacturers(mfrs);
      setProducts(prods);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const allRoles = Array.from(new Set(products.map(p => p.component_role))).sort();

  const filtered = products.filter(p => {
    if (filterMfr && p.manufacturer?.slug !== filterMfr) return false;
    if (filterRole && p.component_role !== filterRole) return false;
    if (filterSearch) {
      const q = filterSearch.toLowerCase();
      if (
        !p.name.toLowerCase().includes(q) &&
        !(p.manufacturer?.name.toLowerCase().includes(q))
      ) return false;
    }
    return true;
  });

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="badge-row">
          <span className="badge warm">Parts Catalogue</span>
          <span className="badge">{products.length} components</span>
          <span className="badge">{manufacturers.length} manufacturers</span>
        </div>
        <h1>FPV Parts Catalogue</h1>
        <p>Browse all components tracked in this installation. Filter by manufacturer, role, or search by name.</p>
      </section>

      <nav className="subnav" aria-label="Main navigation">
        <Link className="subnav-link" href="/">Overview</Link>
        <Link className="subnav-link" href="/drones">Drones</Link>
        <Link className="subnav-link" href="/batteries">Batteries</Link>
        <Link className={`subnav-link${pathname === '/catalogue' ? ' active' : ''}`} href="/catalogue">Catalogue</Link>
        <Link className="subnav-link" href="/snapshots">Snapshots</Link>
      </nav>

      <div className="cat-page">
        <div className="filter-bar">
          <select value={filterMfr} onChange={e => setFilterMfr(e.target.value)}>
            <option value="">All Manufacturers</option>
            {manufacturers.map(m => (
              <option key={m.id} value={m.slug}>{m.name}</option>
            ))}
          </select>
          <select value={filterRole} onChange={e => setFilterRole(e.target.value)}>
            <option value="">All Roles</option>
            {allRoles.map(r => (
              <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Search by name…"
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
          />
          {(filterMfr || filterRole || filterSearch) && (
            <button
              className="button"
              onClick={() => { setFilterMfr(''); setFilterRole(''); setFilterSearch(''); }}
              style={{ whiteSpace: 'nowrap' }}
            >
              Clear filters
            </button>
          )}
          <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {filtered.length} / {products.length} results
          </span>
        </div>

        {loading && <p style={{ color: 'var(--text-muted)' }}>Loading catalogue…</p>}

        {!loading && filtered.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>No products match the current filters.</p>
        )}

        <div className="cat-grid">
          {filtered.map(p => (
            <div key={p.id} className="cat-card">
              {p.image_url
                ? <img src={p.image_url} alt={p.name} className="cat-card-img" />
                : <div className="cat-card-img" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2.5rem' }}>📦</div>
              }
              <span className="cat-card-role">{ROLE_LABELS[p.component_role] ?? p.component_role}</span>
              <span className="cat-card-title">{p.name}</span>
              {p.manufacturer && (
                <span className="cat-card-mfr">{p.manufacturer.name}</span>
              )}
              {p.variants.length > 0 && (
                <span className="cat-card-variants">
                  {p.variants.length} variant{p.variants.length !== 1 ? 's' : ''}
                  {p.variants.length <= 3 && `: ${p.variants.map(v => v.name).join(', ')}`}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
