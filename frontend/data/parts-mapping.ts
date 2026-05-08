import rawSeed from './drone-parts-mapping.seed.json';

export type ComponentRole =
  | 'FRAME'
  | 'FLIGHT_CONTROLLER'
  | 'ESC'
  | 'FC_ESC_STACK'
  | 'AIO_BOARD'
  | 'MOTOR'
  | 'PROPELLER'
  | 'RECEIVER'
  | 'VTX_VIDEO_UNIT'
  | 'CAMERA'
  | 'ANTENNA'
  | 'GPS'
  | 'BATTERY'
  | 'ACCESSORY'
  | 'OTHER';

export type MappedPart = {
  component_role: ComponentRole | string;
  quantity: number;
  name: string;
  manufacturer_hint: string | null;
  source_quality: 'direct' | 'inferred-from-notes';
};

export type DronePartsPreset = {
  template_key: string;
  brand: string;
  model: string;
  category: string;
  frame_size: string;
  manufacturer_product_url: string | null;
  manufacturer_image_url: string | null;
  notes: string | null;
  parts: MappedPart[];
};

export type PartsSeed = {
  version: number;
  generated_at: string;
  source_file: string;
  template_count: number;
  brands: string[];
  component_roles: string[];
  indexes: {
    by_brand: Record<string, string[]>;
    by_role: Record<string, Array<{
      template_key: string;
      brand: string;
      model: string;
      name: string;
      quantity: number;
    }>>;
  };
  presets: DronePartsPreset[];
};

const seed = rawSeed as PartsSeed;

export function getPartsSeed(): PartsSeed {
  return seed;
}

export function getPresetByKey(templateKey: string): DronePartsPreset | undefined {
  return seed.presets.find((preset) => preset.template_key === templateKey);
}

export function listPresetsByBrand(brand: string): DronePartsPreset[] {
  const keys = new Set(seed.indexes.by_brand[brand] ?? []);
  return seed.presets.filter((preset) => keys.has(preset.template_key));
}

export function listPartsByRole(role: string): PartsSeed['indexes']['by_role'][string] {
  return seed.indexes.by_role[role] ?? [];
}

export function searchParts(query: string, opts?: { brand?: string; role?: string }): Array<{
  template_key: string;
  brand: string;
  model: string;
  role: string;
  name: string;
  quantity: number;
}> {
  const normalized = query.trim().toLowerCase();
  const out: Array<{
    template_key: string;
    brand: string;
    model: string;
    role: string;
    name: string;
    quantity: number;
  }> = [];

  for (const preset of seed.presets) {
    if (opts?.brand && preset.brand !== opts.brand) continue;

    for (const part of preset.parts) {
      if (opts?.role && part.component_role !== opts.role) continue;
      if (!normalized || part.name.toLowerCase().includes(normalized) || preset.model.toLowerCase().includes(normalized)) {
        out.push({
          template_key: preset.template_key,
          brand: preset.brand,
          model: preset.model,
          role: part.component_role,
          name: part.name,
          quantity: part.quantity,
        });
      }
    }
  }

  return out;
}
