#!/usr/bin/env node
/**
 * Seed the FPV Catalog API with manufacturers, categories, and products
 * extracted from drone-parts-mapping.seed.json.
 *
 * Usage:
 *   node scripts/seed_catalogue.mjs [--api http://192.168.1.29:8000]
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.argv.find(a => a.startsWith('http')) ?? 'http://192.168.1.29:8000';

const seedPath = resolve(__dirname, '../frontend/data/drone-parts-mapping.seed.json');
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

// ── helpers ────────────────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function getAll(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

// ── step 1: collect unique brands & component_roles ───────────────────────────

const brandWebsites = {
  iFlight: 'https://shop.iflight.com',
  GEPRC: 'https://geprc.com',
  Flywoo: 'https://flywoo.net',
  DeepSpaceFPV: 'https://www.deepspacefpv.com',
};

const roleCategoryNames = {
  FRAME: 'Frames',
  FC_ESC_STACK: 'FC+ESC Stacks',
  FLIGHT_CONTROLLER: 'Flight Controllers',
  ESC: 'ESCs',
  MOTOR: 'Motors',
  PROPELLER: 'Propellers',
  VTX_VIDEO_UNIT: 'VTX / Video Units',
  RECEIVER: 'Receivers',
  GPS: 'GPS Modules',
  CAMERA: 'Cameras',
  BATTERY: 'Batteries',
  ANTENNA: 'Antennas',
  AIO_BOARD: 'AIO Boards',
  ACCESSORY: 'Accessories',
  OTHER: 'Other',
};

// collect unique brands and roles present in seed
const brandsInSeed = [...new Set(seed.presets.map(p => p.brand))];
const rolesInSeed = [...new Set(seed.presets.flatMap(p => p.parts.map(pt => pt.component_role)))];

// ── step 2: upsert manufacturers ──────────────────────────────────────────────

console.log('\n=== Manufacturers ===');
const existingManufacturers = await getAll('/api/manufacturers');
const mfMap = {}; // name → id
for (const m of existingManufacturers) mfMap[m.name] = m.id;

for (const brand of brandsInSeed) {
  if (mfMap[brand]) {
    console.log(`  SKIP  ${brand} (id=${mfMap[brand]})`);
    continue;
  }
  const created = await post('/api/manufacturers', { name: brand, website: brandWebsites[brand] ?? null });
  mfMap[created.name] = created.id;
  console.log(`  ADD   ${brand} (id=${created.id})`);
}

// ── step 3: upsert categories ─────────────────────────────────────────────────

console.log('\n=== Categories ===');
const existingCats = await getAll('/api/categories');
const catMap = {}; // component_role → id
for (const c of existingCats) {
  if (c.component_role) catMap[c.component_role] = c.id;
}

for (const role of rolesInSeed) {
  if (catMap[role]) {
    console.log(`  SKIP  ${role} (id=${catMap[role]})`);
    continue;
  }
  const created = await post('/api/categories', {
    name: roleCategoryNames[role] ?? role,
    component_role: role,
  });
  catMap[role] = created.id;
  console.log(`  ADD   ${role} → "${roleCategoryNames[role] ?? role}" (id=${created.id})`);
}

// ── step 4: collect unique parts, deduplicate by name+role ────────────────────

// key: `${role}||${name}` → { role, name, brand, image_url, product_url }
const uniqueParts = new Map();

for (const preset of seed.presets) {
  for (const part of preset.parts) {
    const key = `${part.component_role}||${part.name}`;
    if (!uniqueParts.has(key)) {
      uniqueParts.set(key, {
        role: part.component_role,
        name: part.name,
        brand: part.manufacturer_hint ?? preset.brand,
        image_url: preset.manufacturer_image_url ?? null,
        product_url: preset.manufacturer_product_url ?? null,
      });
    }
  }
}

console.log(`\n=== Products (${uniqueParts.size} unique) ===`);

// check existing products to avoid duplicates
const existingProducts = await getAll('/api/products');
const existingSet = new Set(existingProducts.map(p => `${p.component_role}||${p.name}`));

let added = 0;
let skipped = 0;

for (const [key, part] of uniqueParts) {
  if (existingSet.has(key)) {
    skipped++;
    continue;
  }
  const mfId = mfMap[part.brand] ?? null;
  const catId = catMap[part.role] ?? null;

  await post('/api/products', {
    name: part.name,
    component_role: part.role,
    manufacturer_id: mfId,
    category_id: catId,
    image_url: part.image_url,
    product_url: part.product_url,
  });
  added++;
  process.stdout.write('.');
}

console.log(`\n  Added: ${added}  Skipped (already exist): ${skipped}`);

// ── summary ───────────────────────────────────────────────────────────────────

const finalCount = await getAll('/api/products');
console.log(`\n=== Done — total products in DB: ${finalCount.length} ===\n`);
