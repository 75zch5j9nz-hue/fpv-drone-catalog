'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

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
  tags: string | null; image_url: string | null;
  description: string | null; specs: string | null; product_url: string | null;
  is_active: boolean;
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

const ROLE_ORDER = [
  'FRAME', 'FC_ESC_STACK', 'FLIGHT_CONTROLLER', 'ESC', 'AIO_BOARD',
  'MOTOR', 'PROPELLER', 'VTX_VIDEO_UNIT', 'CAMERA', 'RECEIVER',
  'ANTENNA', 'GPS', 'BATTERY', 'ACCESSORY', 'OTHER',
];

function parseSpecs(raw: string): Array<{ key: string; value: string }> {
  return raw
    .split(/\n|;/)
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => {
      const idx = line.indexOf(':');
      if (idx === -1) return { key: line, value: '' };
      return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    });
}

export default function CataloguePage() {
  const pathname = usePathname();
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [filterMfr, setFilterMfr] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CatalogueProduct | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

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

  const allRoles = ROLE_ORDER.filter(r => products.some(p => p.component_role === r));

  const filtered = products.filter(p => {
    if (filterMfr && p.manufacturer?.slug !== filterMfr) return false;
    if (filterRole && p.component_role !== filterRole) return false;
    if (filterSearch) {
      const q = filterSearch.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !(p.manufacturer?.name.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const grouped: Array<{ role: string; items: CatalogueProduct[] }> = filterRole
    ? [{ role: filterRole, items: filtered }]
    : allRoles
        .map(role => ({ role, items: filtered.filter(p => p.component_role === role) }))
        .filter(g => g.items.length > 0);

  async function handleSelect(p: CatalogueProduct) {
    if (selected?.id === p.id) { setSelected(null); return; }
    setSelected(p);
    setDetailLoading(true);
    try {
      const detail = await apiFetch<CatalogueProduct>(`/api/products/${p.id}`);
      setSelected(detail);
    } finally {
      setDetailLoading(false);
    }
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
  }

  // Counts per role, filtered only by manufacturer (not by the role selector itself)
  // so the role dropdown always shows accurate counts for the active manufacturer.
  const filteredByMfrSearch = products.filter(p => {
    if (filterMfr && p.manufacturer?.slug !== filterMfr) return false;
    if (filterSearch) {
      const q = filterSearch.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !(p.manufacturer?.name.toLowerCase().includes(q))) return false;
    }
    return true;
  });
  const roleCountsForDropdown: Record<string, number> = {};
  for (const p of filteredByMfrSearch) roleCountsForDropdown[p.component_role] = (roleCountsForDropdown[p.component_role] ?? 0) + 1;
  const availableRoles = ROLE_ORDER.filter(r => (roleCountsForDropdown[r] ?? 0) > 0);

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="badge-row">
          <span className="badge warm">Parts Catalogue</span>
          <span className="badge">{products.length} components</span>
          <span className="badge">{manufacturers.length} manufacturers</span>
        </div>
        <h1>FPV Parts Catalogue</h1>
        <p>Browse all components. Click a row to view full specifications.</p>
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
          <select value={filterMfr} onChange={e => { setFilterMfr(e.target.value); setSelected(null); }}>
            <option value="">All Manufacturers</option>
            {manufacturers.map(m => <option key={m.id} value={m.slug}>{m.name}</option>)}
          </select>
          <select value={filterRole} onChange={e => { setFilterRole(e.target.value); setSelected(null); }}>
            <option value="">All Roles</option>
            {availableRoles.map(r => (
              <option key={r} value={r}>{ROLE_LABELS[r] ?? r} ({roleCountsForDropdown[r] ?? 0})</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Search by name or manufacturer…"
            value={filterSearch}
            onChange={e => { setFilterSearch(e.target.value); setSelected(null); }}
          />
          {(filterMfr || filterRole || filterSearch) && (
            <button className="button" onClick={() => { setFilterMfr(''); setFilterRole(''); setFilterSearch(''); setSelected(null); }}>Clear</button>
          )}
          <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {filtered.length} / {products.length}
          </span>
        </div>

        {loading && <p style={{ color: 'var(--text-muted)' }}>Loading catalogue…</p>}
        {!loading && filtered.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No products match the current filters.</p>}

        <div className="cat-split">
          <div className="cat-list-col">
            {grouped.map(({ role, items }) => (
              <div key={role} className="cat-role-group">
                <div className="cat-role-header">
                  <h3 className="cat-role-title">{ROLE_LABELS[role] ?? role}</h3>
                  <span className="cat-role-count">{items.length}</span>
                </div>
                <div className="cat-list">
                  {items.map(p => (
                    <button
                      key={p.id}
                      className={`cat-row${selected?.id === p.id ? ' selected' : ''}`}
                      onClick={() => void handleSelect(p)}
                    >
                      <div className="cat-row-left">
                        {p.image_url
                          ? <img src={p.image_url} alt="" className="cat-row-thumb" />
                          : <div className="cat-row-thumb-ph" />}
                        <div className="cat-row-info">
                          <span className="cat-row-name">{p.name}</span>
                          {p.manufacturer && <span className="cat-row-mfr">{p.manufacturer.name}</span>}
                        </div>
                      </div>
                      <div className="cat-row-right">
                        {p.variants.length > 0 && (
                          <span className="cat-row-variants">{p.variants.length}v</span>
                        )}
                        <span className="cat-row-arrow">{selected?.id === p.id ? '◀' : '›'}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {selected && (
            <div className="cat-detail-panel" ref={detailRef}>
              <div className="cat-detail-header">
                <div>
                  <span className="cat-card-role">{ROLE_LABELS[selected.component_role] ?? selected.component_role}</span>
                  <h2 className="cat-detail-title">{selected.name}</h2>
                  {selected.manufacturer && (
                    <span className="cat-detail-mfr">
                      {selected.manufacturer.website
                        ? <a href={selected.manufacturer.website} target="_blank" rel="noreferrer">{selected.manufacturer.name} ↗</a>
                        : selected.manufacturer.name}
                    </span>
                  )}
                </div>
                <button className="cat-detail-close" onClick={() => setSelected(null)} aria-label="Close">✕</button>
              </div>

              {detailLoading ? (
                <p style={{ color: 'var(--text-muted)', padding: '16px 0' }}>Loading…</p>
              ) : (
                <>
                  {selected.image_url && (
                    <img src={selected.image_url} alt={selected.name} className="cat-detail-img" />
                  )}

                  <dl className="cat-spec-table">
                    {!selected.category && <div className="cat-spec-row"><dt>Role</dt><dd>{ROLE_LABELS[selected.component_role] ?? selected.component_role}</dd></div>}
                    {selected.category && <div className="cat-spec-row"><dt>Category</dt><dd>{selected.category.name}</dd></div>}
                    {selected.manufacturer && (
                      <div className="cat-spec-row">
                        <dt>Manufacturer</dt>
                        <dd>
                          {selected.manufacturer.website
                            ? <a href={selected.manufacturer.website} target="_blank" rel="noreferrer">{selected.manufacturer.name} ↗</a>
                            : selected.manufacturer.name}
                        </dd>
                      </div>
                    )}
                    {selected.tags && (
                      <div className="cat-spec-row">
                        <dt>Tags</dt>
                        <dd style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                          {selected.tags.split(',').map(t => <span key={t.trim()} className="cat-tag">{t.trim()}</span>)}
                        </dd>
                      </div>
                    )}
                    {selected.description && (
                      <div className="cat-spec-row"><dt>Description</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{selected.description}</dd></div>
                    )}
                    {selected.specs && (
                      <>
                        <div className="cat-spec-divider">Specifications</div>
                        {parseSpecs(selected.specs).map(({ key, value }) => (
                          <div key={key} className="cat-spec-row"><dt>{key}</dt><dd>{value || '—'}</dd></div>
                        ))}
                      </>
                    )}
                  </dl>

                  {!selected.specs && !selected.description && (
                    <p className="cat-no-specs">No detailed specifications on file yet.</p>
                  )}

                  {selected.product_url && (
                    <a href={selected.product_url} target="_blank" rel="noreferrer" className="button" style={{ display: 'inline-flex', marginTop: '12px' }}>
                      View on manufacturer site ↗
                    </a>
                  )}

                  {selected.variants.length > 0 && (
                    <div className="cat-variants-section">
                      <h4 className="cat-variants-title">Variants ({selected.variants.length})</h4>
                      <div className="cat-variants-list">
                        {selected.variants.map(v => (
                          <div key={v.id} className={`cat-variant-row${!v.is_active ? ' inactive' : ''}`}>
                            <span className="cat-variant-name">{v.name}</span>
                            {!v.is_active && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>discontinued</span>}
                            {v.specs && (
                              <div className="cat-variant-specs">
                                {parseSpecs(v.specs).map(({ key, value }) => (
                                  <span key={key} className="cat-variant-spec-chip"><b>{key}:</b> {value}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
