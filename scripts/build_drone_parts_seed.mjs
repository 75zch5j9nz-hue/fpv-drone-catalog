#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sourcePath = path.join(repoRoot, 'frontend', 'app', 'page.tsx');
const outputDir = path.join(repoRoot, 'frontend', 'data');
const outputPath = path.join(outputDir, 'drone-parts-mapping.seed.json');

function slug(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractTemplates(source) {
  const marker = 'const DRONE_TEMPLATES: DroneTemplate[] = [';
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('DRONE_TEMPLATES marker not found in frontend/app/page.tsx');
  }

  const assignIndex = source.indexOf('=', markerIndex);
  const arrayStart = source.indexOf('[', assignIndex);
  if (assignIndex === -1 || arrayStart === -1) {
    throw new Error('Could not locate DRONE_TEMPLATES array start');
  }

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  let arrayEnd = -1;

  for (let i = arrayStart; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '[') {
      depth += 1;
      continue;
    }

    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = i;
        break;
      }
    }
  }

  if (arrayEnd === -1) {
    throw new Error('Could not locate DRONE_TEMPLATES array end');
  }

  const arrayExpression = source.slice(arrayStart, arrayEnd + 1);
  const templates = vm.runInNewContext(arrayExpression, Object.create(null), {
    timeout: 1000,
  });

  if (!Array.isArray(templates)) {
    throw new Error('Extracted DRONE_TEMPLATES is not an array');
  }

  return templates;
}

function deriveVideoRole(videoSystem) {
  const value = String(videoSystem || '').trim().toLowerCase();
  if (!value || value === 'unknown') return null;
  if (value.includes('analog')) return 'VTX_VIDEO_UNIT';
  return 'VTX_VIDEO_UNIT';
}

function maybeAddGpsPart(notes, parts) {
  const text = String(notes || '');
  if (!/\bgps\b/i.test(text)) return;
  parts.push({
    component_role: 'GPS',
    quantity: 1,
    name: 'GPS module (listed on manufacturer page)',
    manufacturer_hint: null,
    source_quality: 'inferred-from-notes',
  });
}

function mapTemplateToParts(template) {
  const brand = template.brand || null;
  const parts = [];

  if (template.frame_name) {
    parts.push({
      component_role: 'FRAME',
      quantity: 1,
      name: template.frame_name,
      manufacturer_hint: brand,
      source_quality: 'direct',
    });
  }

  if (template.stack) {
    parts.push({
      component_role: 'FC_ESC_STACK',
      quantity: 1,
      name: template.stack,
      manufacturer_hint: brand,
      source_quality: 'direct',
    });
  }

  if (template.fc_target) {
    parts.push({
      component_role: 'FLIGHT_CONTROLLER',
      quantity: 1,
      name: template.fc_target,
      manufacturer_hint: brand,
      source_quality: 'direct',
    });
  }

  if (template.motors) {
    parts.push({
      component_role: 'MOTOR',
      quantity: 4,
      name: template.motors,
      manufacturer_hint: brand,
      source_quality: 'direct',
    });
  }

  if (template.props) {
    parts.push({
      component_role: 'PROPELLER',
      quantity: 4,
      name: template.props,
      manufacturer_hint: null,
      source_quality: 'direct',
    });
  }

  const videoRole = deriveVideoRole(template.video_system);
  if (videoRole) {
    parts.push({
      component_role: videoRole,
      quantity: 1,
      name: template.video_system,
      manufacturer_hint: null,
      source_quality: 'direct',
    });
  }

  if (template.radio_link && String(template.radio_link).trim().toLowerCase() !== 'unknown') {
    parts.push({
      component_role: 'RECEIVER',
      quantity: 1,
      name: template.radio_link,
      manufacturer_hint: null,
      source_quality: 'direct',
    });
  }

  maybeAddGpsPart(template.notes, parts);

  return {
    template_key: `${slug(template.brand)}-${slug(template.model)}`,
    brand: template.brand,
    model: template.model,
    category: template.category,
    frame_size: template.frame,
    manufacturer_product_url: template.product_url,
    manufacturer_image_url: template.image_url,
    notes: template.notes,
    parts,
  };
}

function main() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const templates = extractTemplates(source);

  const mapped = templates.map(mapTemplateToParts);

  const byBrand = {};
  const byRole = {};
  for (const preset of mapped) {
    byBrand[preset.brand] ??= [];
    byBrand[preset.brand].push(preset.template_key);

    for (const part of preset.parts) {
      byRole[part.component_role] ??= [];
      byRole[part.component_role].push({
        template_key: preset.template_key,
        brand: preset.brand,
        model: preset.model,
        name: part.name,
        quantity: part.quantity,
      });
    }
  }

  const payload = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_file: 'frontend/app/page.tsx#DRONE_TEMPLATES',
    template_count: mapped.length,
    brands: Object.keys(byBrand).sort(),
    component_roles: Object.keys(byRole).sort(),
    indexes: {
      by_brand: byBrand,
      by_role: byRole,
    },
    presets: mapped,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Generated ${outputPath}`);
  console.log(`Templates mapped: ${mapped.length}`);
}

main();
