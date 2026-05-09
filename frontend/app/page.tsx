'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { FormEvent, Fragment, useCallback, useEffect, useState, useTransition } from 'react';
import seedJson from '../data/drone-parts-mapping.seed.json';

type FileRole = 'dump' | 'diff_all' | 'status' | 'version' | 'photo' | 'blackbox' | 'misc';
type DroneStatus = 'flyable' | 'needs_repair' | 'grounded_crash' | 'in_build' | 'retired' | 'for_parts';
type BatteryChemistry = 'lipo' | 'lihv' | 'li_ion';

type StoredFile = {
  id: number;
  role: FileRole;
  original_filename: string | null;
  mime_type: string | null;
  sha256: string;
  size_bytes: number;
  parse_status: string;
  text_excerpt: string | null;
  created_at: string;
};

type Snapshot = {
  id: number;
  name: string;
  slug: string;
  betaflight_version: string | null;
  notes: string | null;
  is_current: boolean;
  is_known_good: boolean;
  created_at: string;
  files: StoredFile[];
};

type Note = {
  id: number;
  title: string;
  note: string;
  created_at: string;
  // Flight note optional fields
  battery_id?: number | null;
  duration_minutes?: number | null;
  battery_used_percent?: number | null;
  flight_date?: string | null;
  location?: string | null;
  wind_speed_kmh?: number | null;
  temperature_c?: number | null;
  outcome?: string;
  motor_temps?: string | null;
  battery_voltage_after?: number | null;
  // Maintenance event optional fields
  event_type?: string;
  damage_items?: string | null;
  repair_cost_pln?: number | null;
  crash_severity?: string | null;
  spare_parts_used?: string | null;
};

type PreflightItem = {
  id: number;
  drone_id: number;
  label: string;
  order_idx: number;
  is_required: boolean;
  created_at: string;
};

type SpareStock = {
  id: number;
  part_name: string;
  category: string | null;
  quantity: number;
  low_stock_threshold: number;
  drone_id: number | null;
  product_id: number | null;
  notes: string | null;
  created_at: string;
};

type QrModalState = { entityType: 'drone' | 'battery'; id: number; label: string };

type Drone = {
  id: number;
  name: string;
  slug: string;
  frame: string | null;
  stack: string | null;
  motors: string | null;
  props: string | null;
  notes: string | null;
  status: DroneStatus;
  auw_grams: number | null;
  fc_target: string | null;
  radio_link: string | null;
  video_system: string | null;
  image_url: string | null;
  category: string | null;
  operator_id: string | null;
  registration_country: string | null;
  registration_expiry: string | null;
  remote_id_module: string | null;
  current_build_version_id: number | null;
  created_at: string;
  updated_at: string;
  snapshots: Snapshot[];
  flight_notes: Note[];
  maintenance_events: Note[];
  current_hardware: InstalledComponent[];
};

type Battery = {
  id: number;
  label: string;
  cell_count: number;
  capacity_mah: number;
  chemistry: BatteryChemistry;
  cycle_count: number;
  purchase_date: string | null;
  notes: string | null;
  batt_status: string;
  is_puffed: boolean;
  internal_resistance_mohm: number | null;
  ir_c1_mohm: number | null;
  ir_c2_mohm: number | null;
  ir_c3_mohm: number | null;
  ir_c4_mohm: number | null;
  ir_c5_mohm: number | null;
  ir_c6_mohm: number | null;
  last_charged_at: string | null;
  voltage_after_last_flight: number | null;
  assigned_drone_id: number | null;
  created_at: string;
  updated_at: string;
};

type PidAxis = { p: number | null; i: number | null; d: number | null; f: number | null };
type SimplifiedPids = { mode?: string; master?: number | null; pi_gain?: number | null; d_gain?: number | null; i_gain?: number | null; ff_gain?: number | null };
type RateAxis = { rc_rate: number | null; super_rate: number | null; expo: number | null };
type SnapshotSummary = {
  pids?: Record<string, PidAxis> & { _simplified?: SimplifiedPids | null };
  rates?: { type: string; axes: Record<string, RateAxis>; tpa?: { rate: number; breakpoint: number } };
  filters?: { mode?: string; gyro_lpf1_hz?: number; gyro_lpf2_hz?: number; dterm_lpf_hz?: number; rpm_filter?: number; dyn_notch?: { count: number; min_hz: number; max_hz: number }; gyro_multiplier?: number; dterm_multiplier?: number };
  motor?: { protocol?: string; poles?: number; idle_pct?: number; idle_min_rpm?: number; throttle_boost?: number; output_limit_pct?: number };
  vtx?: { band?: number; channel?: number; power_level?: number; freq_mhz?: number };
  receiver?: { provider?: string; rssi_src?: string };
};

type RawSnapshotResponse = {
  snapshot_id: number;
  summary?: SnapshotSummary | null;
  files: Array<{
    file_id: number;
    role: FileRole;
    original_filename: string | null;
    content: string;
    parsed_config: Record<string, Array<{key: string; value: string}>> | null;
  }>;
};

type CompareResponse = {
  left_snapshot_id: number;
  right_snapshot_id: number;
  added_lines: number;
  removed_lines: number;
  diff: string;
};

type AppStats = {
  drones: { total: number; flyable: number; grounded: number };
  snapshots: number;
  batteries: number;
  products: number;
  flights: number;
  maintenance: number;
  by_video: Record<string, number>;
  by_category: Record<string, number>;
};

type DroneReadiness = 'ready' | 'needs_backup' | 'stale_backup' | 'incomplete' | 'grounded';

// ── Catalogue types ────────────────────────────────────────────────────────────

type ComponentRole =
  | 'FRAME' | 'FLIGHT_CONTROLLER' | 'ESC' | 'FC_ESC_STACK' | 'AIO_BOARD'
  | 'MOTOR' | 'PROPELLER' | 'RECEIVER' | 'VTX_VIDEO_UNIT' | 'CAMERA'
  | 'ANTENNA' | 'GPS' | 'BATTERY' | 'ACCESSORY' | 'OTHER';

const ROLE_DEFAULT_QTY: Partial<Record<ComponentRole, number>> = { MOTOR: 4, PROPELLER: 4 };
const ROLE_LABELS: Record<ComponentRole, string> = {
  FRAME: 'Frame', FLIGHT_CONTROLLER: 'Flight Controller', ESC: 'ESC',
  FC_ESC_STACK: 'FC + ESC Stack', AIO_BOARD: 'AIO Board', MOTOR: 'Motor',
  PROPELLER: 'Propeller', RECEIVER: 'Receiver', VTX_VIDEO_UNIT: 'VTX / Video',
  CAMERA: 'Camera', ANTENNA: 'Antenna', GPS: 'GPS', BATTERY: 'Battery',
  ACCESSORY: 'Accessory', OTHER: 'Other',
};
const ALL_ROLES: ComponentRole[] = [
  'FRAME','FC_ESC_STACK','FLIGHT_CONTROLLER','ESC','AIO_BOARD',
  'MOTOR','PROPELLER','RECEIVER','VTX_VIDEO_UNIT','CAMERA',
  'ANTENNA','GPS','BATTERY','ACCESSORY','OTHER',
];

type Manufacturer = { id: number; name: string; slug: string; website: string | null; };
type ProductCategory = { id: number; name: string; slug: string; component_role: string; };
type ProductVariant = { id: number; slug: string; name: string; specs: string | null; is_active: boolean; };
type CatalogueProduct = {
  id: number; slug: string; name: string; component_role: string;
  tags: string | null; image_url: string | null; is_active: boolean;
  manufacturer: Manufacturer | null; category: ProductCategory | null;
  variants: ProductVariant[];
};

type InstalledComponent = {
  id: number; build_version_id: number; component_role: ComponentRole;
  product_id: number | null; product_variant_id: number | null;
  custom_name: string | null; custom_manufacturer: string | null;
  custom_notes: string | null; quantity: number;
  firmware_version: string | null;
  installed_at: string; removed_at: string | null;
  product: CatalogueProduct | null; product_variant: ProductVariant | null;
};

// Pending component selection (before saving drone)
type PendingComponent = {
  _key: string; // client-side uniqueness key
  component_role: ComponentRole;
  product_id: number | null;
  product_variant_id: number | null;
  custom_name: string | null;
  custom_manufacturer: string | null;
  custom_notes: string | null;
  quantity: number;
  // Display helpers
  display_name: string;
  display_mfr: string | null;
};

// Drone templates used for quick-fill
type DroneTemplate = {
  brand: string;
  model: string;
  frame: string;
  frame_name: string;
  stack: string | null;
  motors: string | null;
  props: string | null;
  video_system: string | null;
  radio_link: string | null;
  fc_target: string | null;
  auw_grams: number | null;
  category: string;
  notes: string | null;
  image_url: string | null;
  product_url: string | null;
};

const DRONE_TEMPLATES: DroneTemplate[] = [
  { brand:'iFlight', model:'Nazgul Evoque F5 V2', frame:'5"', frame_name:'Nazgul Evoque F5 V2', stack:'BLITZ Mini F7 + E55S 55A', motors:'XING2 2207 1750KV', props:'5.1"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:315, category:'freestyle', notes:'Squashed-X. 4S/6S. Caddx Ratel2 camera.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Fstore%2Fproduct%2FNazgul%2FNazgu-F5-V2%2FF5D-V2-O4-M1.png', product_url:'https://shop.iflight.com/freestyle-quads-cat29' },
  { brand:'iFlight', model:'Nazgul Evoque F5D V2', frame:'5"', frame_name:'Nazgul Evoque F5D V2', stack:'BLITZ Mini F722 + 55A ESC', motors:'XING2 2207 1750KV 6S', props:'5.1"', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F722', auw_grams:385, category:'freestyle / cinematic', notes:'DeadCat geometry. GPS optional. 4S/6S.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Fstore%2Fproduct%2FNazgul%2FNazgu-F5-V2%2FF5D-V2-O4-M1.png', product_url:'https://shop.iflight.com/freestyle-quads-cat29' },
  { brand:'iFlight', model:'Nazgul Evoque F5 V3', frame:'5"', frame_name:'Nazgul Evoque F5 V3', stack:'BLITZ Mini F7 + 60A ESC', motors:'XING2 2207 1750KV 6S', props:'5.1"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:420, category:'freestyle', notes:'DC or X geometry. GPS version available. 2025 flagship.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Fstore%2Fproduct%2FNazgul%2FNazgul-F5-V3%2FNazgul-F5-V3-M1.jpg', product_url:'https://shop.iflight.com/freestyle-quads-cat29' },
  { brand:'iFlight', model:'Nazgul XL5 ECO O4', frame:'5"', frame_name:'Nazgul XL5 ECO', stack:'BLITZ F7 + 55A ESC', motors:'XING 2207 1800KV', props:'5.1"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F722', auw_grams:398, category:'freestyle', notes:'Budget 5-inch with O4-ready layout and serviceable arms.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Fstore%2Fproduct%2FEco%2FNazgul-XL5-ECO%2FXL5-ECO-V1.1-N7.png', product_url:'https://shop.iflight.com/freestyle-quads-cat29' },
  { brand:'iFlight', model:'Chimera7 Pro V2 O4', frame:'7"', frame_name:'Chimera7 Pro V2', stack:'BLITZ F7 + 55A ESC', motors:'XING2 2809 1250KV', props:'7"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:690, category:'long-range', notes:'Long-range 7-inch platform with GPS and high-efficiency tune profile.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Fstore%2Fproduct%2FChimera7-Pro%2FChimera7-Pro-V2-BNF%2FC7-V2-O4-M7.png', product_url:'https://shop.iflight.com/long-range-quads-cat325' },
  { brand:'iFlight', model:'Chimera5 Pro V2 O4', frame:'5"', frame_name:'Chimera5 Pro V2', stack:'BLITZ F7 + 55A ESC', motors:'XING2 2207 1750KV', props:'5.1"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:458, category:'long-range / freestyle', notes:'Long-range oriented 5-inch with GPS and deadcat visibility.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Fstore%2Fproduct%2FChimera7-Pro%2FChimera7-Pro-V2-BNF%2FC7-V2-O4-M7.png', product_url:'https://shop.iflight.com/long-range-quads-cat325' },
  { brand:'iFlight', model:'Protek35 O4', frame:'3.5"', frame_name:'Protek35', stack:'BLITZ F722 + 45A AIO', motors:'2205.5 2150KV', props:'3.5"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F722', auw_grams:286, category:'cinematic', notes:'3.5-inch ducted cinewhoop for proximity and indoor/outdoor cinematic work.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Fstore%2Fproduct%2FDefender%2FD20%2FDefender20-M1.png', product_url:'https://shop.iflight.com/cinewhoop-cat370' },
  { brand:'iFlight', model:'Mach R5 Sport', frame:'5"', frame_name:'Mach R5', stack:'BLITZ F7 + 55A ESC', motors:'XING2 2207 2400KV 6S', props:'5.1"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:335, category:'racing', notes:'True-X racing frame. High-KV motors. 6S.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Foss%2F20260408%2F144451%2Fadmin15%2F49494.png', product_url:'https://shop.iflight.com/race-quads-cat28' },
  { brand:'iFlight', model:'Defender 20 Lite O4', frame:'2"', frame_name:'Defender 20', stack:'BLITZ F411 AIO + 20A', motors:'1103 14000KV', props:'2"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F411RX', auw_grams:88, category:'cinematic / indoor', notes:'2-inch ducted cinewhoop. 2S.',
    image_url:'/api/proxy-image?url=https%3A%2F%2Fiflight.oss-cn-hongkong.aliyuncs.com%2Fstore%2Fproduct%2FDefender%2FD20-Lite%2FD20-Lite-M0.png', product_url:'https://shop.iflight.com/cinewhoop-cat370' },
  { brand:'GEPRC', model:'Mark5 Analog', frame:'5"', frame_name:'GEP-MK5 225mm', stack:'GEPRC F7 + 50A BL_32 ESC', motors:'SPEEDX2 2107.5 1960KV', props:'5"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722', auw_grams:365, category:'freestyle', notes:'225mm True-X. HD (O3) and DC O4 Pro variants also available.',
    image_url:'https://geprc.com/wp-content/uploads/2022/01/10-8.jpg', product_url:'https://geprc.com/product/geprc-mark5-analog-freestyle-fpv-drone/' },
  { brand:'GEPRC', model:'Mark5 DC O4 Pro', frame:'5"', frame_name:'GEP-MK5 DC 230mm', stack:'TAKER F7 + 50A ESC', motors:'SPEEDX2 2107.5 1960KV', props:'5"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722_BT_HD', auw_grams:395, category:'freestyle / cinematic', notes:'DeadCat GPS. 230mm wheelbase. 2025 release.',
    image_url:'https://geprc.com/wp-content/uploads/2025/04/1_Main_0000-5-600x600.jpg', product_url:'https://geprc.com/product/geprc-mark5-o4-pro-dc-fpv-drone/' },
  { brand:'GEPRC', model:'Mark4 HD O4 Pro', frame:'4"', frame_name:'GEP-MK4', stack:'TAKER F722 + 45A ESC', motors:'SPEEDX2 2004 2850KV', props:'4"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722_BT_HD', auw_grams:258, category:'freestyle / compact', notes:'Compact 4-inch build balancing agility and cleaner footage.',
    image_url:'https://geprc.com/wp-content/uploads/2020/07/14-2-1200x1200.jpg', product_url:'https://geprc.com/products/' },
  { brand:'GEPRC', model:'CineLog30 V3 O4', frame:'3"', frame_name:'CineLog30 V3', stack:'TAKER F411 + 35A AIO', motors:'1404 3850KV', props:'3"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF405_BT_HD', auw_grams:168, category:'cinematic', notes:'3-inch ducted platform between CL25 and CL35 for mixed indoor/outdoor work.',
    image_url:'https://geprc.com/wp-content/uploads/2025/01/1_DeMain_0075-600x600.jpg', product_url:'https://geprc.com/product/geprc-cinelog30-v3-o4-pro-quadcopter/' },
  { brand:'GEPRC', model:'CineLog20 O4', frame:'2"', frame_name:'CineLog20', stack:'TAKER F411 20A AIO', motors:'1202.5 6500KV', props:'2"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF405_BT_HD', auw_grams:112, category:'cinematic / indoor', notes:'Compact 2-inch cinewhoop focused on tight spaces and low-noise flights.',
    image_url:'https://geprc.com/wp-content/uploads/2023/01/GEPRC-Cinelog20-HD-O3-FPV-Drone-3-600x600.jpg', product_url:'https://geprc.com/product/geprc-cinelog20-hd-o3-fpv-drone/' },
  { brand:'GEPRC', model:'SMART 35 HD', frame:'3.5"', frame_name:'SMART 35', stack:'GEPRC F722 + 45A ESC', motors:'2105.5 2650KV', props:'3.5"', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722', auw_grams:232, category:'freestyle / cinematic', notes:'Unducted 3.5-inch with HD payload capacity and robust frame.',
    image_url:'https://geprc.com/wp-content/uploads/2025/09/1_DeMain_0000-3-600x600.jpg', product_url:'https://geprc.com/products/' },
  { brand:'GEPRC', model:'Cinebot30 HD O3', frame:'3"', frame_name:'Cinebot30 127mm', stack:'GEPRC F7 45A AIO V2', motors:'SPEEDX2 1804 2450KV', props:'3"', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF745_BT_HD', auw_grams:195, category:'cinematic', notes:'127mm cinewhoop. 4S/6S.',
    image_url:'https://geprc.com/wp-content/uploads/2022/10/9-1-600x600.jpg', product_url:'https://geprc.com/product/geprc-cinebot30-hd-runcam-link-wasp-fpv-drone/' },
  { brand:'GEPRC', model:'CineLog35 V3 O4 Pro', frame:'3.5"', frame_name:'GEP-CL35 V3 142mm', stack:'TAKER F7 + 45A AIO', motors:'SPEEDX2 2105.5 2650KV', props:'3.5"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722_BT_HD', auw_grams:215, category:'cinematic', notes:'142mm ducted. GPS. 6S.',
    image_url:'https://geprc.com/wp-content/uploads/2025/09/1_DeMain_0000-3-600x600.jpg', product_url:'https://geprc.com/product/geprc-cinelog35-v3-o4-pro-fpv-drone/' },
  { brand:'GEPRC', model:'Tern LR40', frame:'4"', frame_name:'Tern LR40', stack:'TAKER G4 45A AIO', motors:'SPEEDX2 1404 3000KV', props:'4"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF405_BT_HD', auw_grams:155, category:'long-range', notes:'Sub-250g 4-inch long range. 4S.',
    image_url:'https://geprc.com/wp-content/uploads/2023/12/1_Main_0003_00000-4-600x600.jpg', product_url:'https://geprc.com/product/geprc-tern-lr40-hd-o3-long-range-fpv/' },
  { brand:'Flywoo', model:'Explorer LR 4 O4', frame:'4"', frame_name:'Explorer LR 4', stack:'GOKU F405 AIO + 20A ESC', motors:'ROBO 2004 1700KV', props:'4"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:242, category:'long-range', notes:'Sub-250g. 3S. GPS PRO variant also available.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/1-76.jpeg', product_url:'https://flywoo.net/products/explorer-lr-4-o4-sub250-4k-1080p-micro-long-range' },
  { brand:'Flywoo', model:'Explorer LR 4 PRO O4', frame:'4"', frame_name:'Explorer LR 4 PRO', stack:'GOKU F405 HD + 20A ESC', motors:'ROBO 2004 1700KV', props:'4"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:248, category:'long-range', notes:'Pro variant with stronger camera protection and GPS-first long-range layout.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/Explorer-O4PRO-2.jpeg', product_url:'https://flywoo.net/products/explorer-lr-4-o4-pro-sub250-4k-1080p-micro-long-range' },
  { brand:'Flywoo', model:'Explorer LR 4 Nano', frame:'4"', frame_name:'Explorer LR 4 Nano', stack:'GOKU F405 Nano + 16A ESC', motors:'1404 2750KV', props:'4"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:182, category:'long-range / ultralight', notes:'Ultralight analog LR platform for efficient cruising.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/1-76.jpeg', product_url:'https://flywoo.net/collections/fpv-drone' },
  { brand:'Flywoo', model:'Firefly 20 PRO O4 Wide', frame:'2"', frame_name:'Firefly 20 PRO', stack:'GOKU F405 AIO + 20A', motors:'1404 3800KV', props:'2"', video_system:'DJI O4 Wide', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:78, category:'cinematic / micro', notes:'2-inch micro O4 wide-angle. 4S.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/FIREFLY-20PRO-Drone-kit-4.webp', product_url:'https://flywoo.net/products/firefly-20pro-4s-25mini-3s-o4-wide-micro-drone' },
  { brand:'Flywoo', model:'Firefly 25 Nano Baby O4', frame:'2.5"', frame_name:'Firefly 25 Nano Baby', stack:'GOKU F405 20A AIO', motors:'1404 4600KV', props:'2.5"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:118, category:'micro / freestyle', notes:'2.5-inch lightweight build tuned for tight freestyle and quick recovery.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/FIREFLY-20PRO-Drone-kit-4.webp', product_url:'https://flywoo.net/collections/fpv-drone' },
  { brand:'Flywoo', model:'Firefly 16 Nano Baby V3 O4', frame:'1.6"', frame_name:'Firefly 16 Nano Baby V3', stack:'GOKU F411 5-in-1 + 12A', motors:'1102 8700KV', props:'1.6"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF411_AIO', auw_grams:38, category:'nano / micro cinematic', notes:'1S nano with upgraded V3 frame and stronger camera cage.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/16-O4-Drone-kit-1-0.jpeg', product_url:'https://flywoo.net/products/firefly16-1s-nano-baby-v3-o4-tiny-drone' },
  { brand:'Flywoo', model:'FlyLens 75 HD O4', frame:'1.6"', frame_name:'FlyLens 75', stack:'GOKU F411 12A AIO', motors:'1002 22000KV', props:'1.6"', video_system:'DJI O4 Lite', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF411_AIO', auw_grams:46, category:'indoor whoop', notes:'75mm micro whoop for indoor cinematic lines and low acoustic footprint.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/flylens75-O4pro-Drone-kit-3.jpg', product_url:'https://flywoo.net/products/flylens-75-hd-o4-2s-whoop-fpv-drone' },
  { brand:'Flywoo', model:'FlyLens 85 HD O4', frame:'2"', frame_name:'FlyLens 85', stack:'GOKU F405 AIO + 20A', motors:'1202.5 12000KV', props:'2"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:52, category:'cinematic / indoor whoop', notes:'85mm ducted whoop. 2S.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/flylens85-O4pro-Frame-kit-3.jpg', product_url:'https://flywoo.net/products/flylens-85-hd-o4-2s-whoop-fpv-drone' },
  { brand:'Flywoo', model:'Vampire 5 HD O3', frame:'5"', frame_name:'Vampire 5', stack:'GOKU F745 AIO + 45A', motors:'ROBO 2207 1750KV', props:'5.1"', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF745AIO', auw_grams:375, category:'freestyle', notes:'5-inch freestyle. 6S.',
    image_url:'https://img-va.myshopline.com/image/store/1673593876355/Explorer-O4PRO-2.jpeg', product_url:'https://flywoo.net/collections/fpv-drone' },
  { brand:'DeepSpaceFPV', model:'SEEKER5 O4 Pro', frame:'5"', frame_name:'SEEKER5 DC/XL 215mm', stack:'HAKRC F722 V2 + 60A ESC', motors:'Aether 2207.3 1960KV', props:'5.1" Gemfan 51433', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722', auw_grams:382, category:'freestyle', notes:'5-inch DC/XL freestyle with GPS. Also O3 and Analog PNP variants. 6S.',
    image_url:'https://www.deepspacefpv.com/cdn/shop/16631/product/detail/20260225/1772006966433_0.png', product_url:'https://www.deepspacefpv.com/DeepSpace-SEEKER5-5inch-freestyle-FPV-Drone-DJI-O3-Air-Unit-Analog-PNP-with-GPS-6S-p6219507.html' },
  { brand:'DeepSpaceFPV', model:'SEEKER5 O3', frame:'5"', frame_name:'SEEKER5 DC/XL 215mm', stack:'HAKRC F722 V2 + 60A ESC', motors:'Aether 2207.3 1960KV', props:'5.1" Gemfan 51433', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722', auw_grams:375, category:'freestyle', notes:'5-inch DC/XL freestyle with GPS. O3 Air Unit variant. 6S.',
    image_url:'https://www.deepspacefpv.com/cdn/shop/16631/product/detail/20260225/1772006966433_0.png', product_url:'https://www.deepspacefpv.com/DeepSpace-SEEKER5-5inch-freestyle-FPV-Drone-DJI-O3-Air-Unit-Analog-PNP-with-GPS-6S-p6219507.html' },
  { brand:'DeepSpaceFPV', model:'SEEKER35 O4 Pro', frame:'3.5"', frame_name:'SEEKER35 DC/XL', stack:'TALOS F722AIO BL32-40A', motors:'Aether 2006 2550KV', props:'3.5" HQ DT90mm', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:228, category:'freestyle', notes:'3.5-inch DC/XL freestyle, GPS, 6S. Also Analog PNP variant.',
    image_url:'https://www.deepspacefpv.com/cdn/shop/16631/product/detail/20251009/1760009123401_0.png', product_url:'https://www.deepspacefpv.com/DeepSpace-SEEKER35-35inch-DCXL-freestyle-FPV-Drone-DJI-O4-PRO-Analog-PNP-with-GPS-6S-p6775423.html' },
  { brand:'DeepSpaceFPV', model:'SEEKER3 O4 Pro', frame:'3"', frame_name:'SEEKER3 DC/XL', stack:'HAKRC F722 mini V2 + 40A ESC', motors:'Aether 1505 4000KV', props:'3" HQProp T3x3x3', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:165, category:'freestyle', notes:'Sub-250g 3-inch freestyle with GPS. 4S. DC/XL geometry.',
    image_url:'https://www.deepspacefpv.com/cdn/shop/16631/product/detail/20260428/1777342060010_0.png', product_url:'https://www.deepspacefpv.com/DeepSpace-SEEKER3-3inch-freestyle-FPV-Drone-DJI-O4-PRO-Analog-PNP-with-GPS-4S-sub250g-p6408559.html' },
  { brand:'DeepSpaceFPV', model:'SEEKER3 Analog', frame:'3"', frame_name:'SEEKER3 DC/XL', stack:'HAKRC F722 mini V2 + 40A ESC', motors:'Aether 1505 4000KV', props:'3" HQProp T3x3x3', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:148, category:'freestyle', notes:'Sub-250g 3-inch analog freestyle. GPS. 4S.',
    image_url:'https://www.deepspacefpv.com/cdn/shop/16631/product/detail/20260428/1777342060010_0.png', product_url:'https://www.deepspacefpv.com/DeepSpace-SEEKER3-3inch-freestyle-FPV-Drone-DJI-O4-PRO-Analog-PNP-with-GPS-4S-sub250g-p6408559.html' },
  { brand:'DeepSpaceFPV', model:'Stellar 25 O4 Pro', frame:'2.5"', frame_name:'Stellar 25', stack:'TALOS F722AIO BL32-40A', motors:'Aether 1404 4600KV', props:'2.5" Gemfan D63', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:122, category:'cinematic / micro', notes:'2.5-inch micro. GPS optional. O4 Pro (bring cam/VTX). 4S.',
    image_url:'https://www.deepspacefpv.com/cdn/shop/16631/product/detail/20251129/1764385133375_0.jpg', product_url:'https://www.deepspacefpv.com/DeepSpace-Stellar-25-25inch-Drone-HD-O4PROWithout-Cam-VTXVersion-FPV-Drone-Quadcopter-with-Aether-1404-Motor-p6549463.html' },
  { brand:'DeepSpaceFPV', model:'ROC7 O4 Pro', frame:'7"', frame_name:'ROC7 322mm', stack:'HAKRC F722 V2 + 60A ESC', motors:'RED LINE 2807 1350KV', props:'7"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722', auw_grams:748, category:'long-range', notes:'7-inch long-range freestyle. T700 carbon fiber. GPS. 6S.',
    image_url:'https://www.deepspacefpv.com/cdn/shop/16631/product/detail/20250729/1753784761400_0.png', product_url:'https://www.deepspacefpv.com/DeepSpace-ROC7-O4PRO-Long-Range-FPV-7Inch-F722-60A-Racing-Drone-Quadcopter-Freestyle-p6638729.html' },
  { brand:'DeepSpaceFPV', model:'ROC4 O4 Pro', frame:'4"', frame_name:'ROC4 DC-Type', stack:'TALOS F722AIO BL32-40A', motors:'Aether 1404 3000KV', props:'4"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:238, category:'long-range', notes:'4-inch DC-type long range with GPS. Sub-250g. 4S.',
    image_url:'https://www.deepspacefpv.com/cdn/shop/16631/product/detail/20260110/1768046292509_0.png', product_url:'https://www.deepspacefpv.com/DeepSpace-ROC-4-FPV-Drone-4-InchLong-Range-Quadcopter-with-GPS-DC-Type-Structure-p6899050.html' },
];

const apiBase = process.env.NEXT_PUBLIC_API_URL || '';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATUS_META: Record<DroneStatus, {label: string; color: string; bg: string}> = {
  flyable:        { label: 'Flyable',       color: '#4fc38a', bg: 'rgba(79,195,138,0.15)' },
  needs_repair:   { label: 'Needs repair',  color: '#f0a830', bg: 'rgba(240,168,48,0.15)' },
  grounded_crash: { label: 'Crashed / grounded', color: '#e04040', bg: 'rgba(224,64,64,0.15)' },
  in_build:       { label: 'In build',      color: '#60a0f0', bg: 'rgba(96,160,240,0.15)' },
  retired:        { label: 'Retired',       color: '#7a8599', bg: 'rgba(122,133,153,0.15)' },
  for_parts:      { label: 'For parts',     color: '#7a8599', bg: 'rgba(122,133,153,0.12)' },
};

const READINESS_META: Record<DroneReadiness, { label: string; color: string; bg: string }> = {
  ready:        { label: 'Ready',        color: '#4fc38a', bg: 'rgba(79,195,138,0.16)' },
  needs_backup: { label: 'Needs backup', color: '#60a0f0', bg: 'rgba(96,160,240,0.16)' },
  stale_backup: { label: 'Stale backup', color: '#f0a830', bg: 'rgba(240,168,48,0.16)' },
  incomplete:   { label: 'Incomplete',   color: '#f0a830', bg: 'rgba(240,168,48,0.16)' },
  grounded:     { label: 'Grounded',     color: '#e04040', bg: 'rgba(224,64,64,0.16)' },
};

function normalizeCategory(value: string | null): string {
  return (value ?? '').toLowerCase().replace(/_/g, '-').trim();
}

/** Battery health 0-100. Degraded by cycles, age, puffing, IR. */
function getBatteryHealth(bat: Battery): number {
  let health = 100;
  const maxCycles = bat.chemistry === 'li_ion' ? 400 : 200;
  health -= Math.min(50, (bat.cycle_count / maxCycles) * 50);
  if (bat.purchase_date) {
    const months = (Date.now() - new Date(bat.purchase_date).getTime()) / (30 * 86_400_000);
    health -= Math.min(20, (months / 24) * 20);
  }
  if (bat.is_puffed) health -= 25;
  if (bat.internal_resistance_mohm && bat.internal_resistance_mohm > 30) health -= Math.min(15, (bat.internal_resistance_mohm - 30) / 10 * 5);
  return Math.max(0, Math.round(health));
}

const BATT_STATUS_META: Record<string, {label: string; color: string; bg: string}> = {
  active:    { label: 'Active',    color: '#4fc38a', bg: 'rgba(79,195,138,0.15)' },
  watchlist: { label: 'Watchlist', color: '#f0a830', bg: 'rgba(240,168,48,0.15)' },
  retired:   { label: 'Retired',   color: '#7a8599', bg: 'rgba(122,133,153,0.15)' },
  damaged:   { label: 'Damaged',   color: '#e04040', bg: 'rgba(224,64,64,0.15)' },
};

function getDroneIssues(drone: Drone): string[] {
  const issues: string[] = [];
  if (!drone.snapshots.length) issues.push('No Betaflight snapshot');
  if (!drone.auw_grams) issues.push('Missing AUW');
  if (!drone.radio_link) issues.push('Missing radio link');
  if (!drone.stack && !drone.fc_target) issues.push('Missing stack / FC');
  if (!drone.video_system) issues.push('Missing video system');
  if (drone.snapshots.length) {
    const newest = drone.snapshots.reduce((a, b) => a.created_at > b.created_at ? a : b);
    const ageDays = (Date.now() - new Date(newest.created_at).getTime()) / 86_400_000;
    if (ageDays > 30) issues.push('Stale snapshot (>30 days)');
  }
  return issues;
}

function getDroneReadiness(drone: Drone): DroneReadiness {
  if (drone.status !== 'flyable') return 'grounded';
  const issues = getDroneIssues(drone);
  const hasBackupGap = issues.includes('No Betaflight snapshot');
  const nonBackupIssues = issues.filter(issue => issue !== 'No Betaflight snapshot');
  if (nonBackupIssues.length) return 'incomplete';
  if (hasBackupGap) return 'needs_backup';
  return 'ready';
}

export default function HomePage() {
  const pathname = usePathname();
  const router = useRouter();
  const isOverviewPage = pathname === '/';
  const isDronesPage = pathname === '/drones';
  const isBatteriesPage = pathname === '/batteries';
  const showDroneSections = !isBatteriesPage && !isOverviewPage;
  const showBatterySections = !isDronesPage && !isOverviewPage;

  const [drones, setDrones] = useState<Drone[]>([]);
  const [batteries, setBatteries] = useState<Battery[]>([]);
  const [selectedDroneId, setSelectedDroneId] = useState<number | null>(null);
  const [editDroneId, setEditDroneId] = useState<number | null>(null);
  const [editSnapshotId, setEditSnapshotId] = useState<number | null>(null);
  const [fleetFilter, setFleetFilter] = useState<DroneStatus | 'all'>('all');
  const [fleetSearch, setFleetSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [readinessFilter, setReadinessFilter] = useState<DroneReadiness | 'all'>('all');
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editingNoteTab, setEditingNoteTab] = useState<'flights' | 'maintenance' | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateBrand, setTemplateBrand] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [rawSnapshot, setRawSnapshot] = useState<RawSnapshotResponse | null>(null);
  const [compareResult, setCompareResult] = useState<CompareResponse | null>(null);
  const [status, setStatus] = useState('Loading drones...');
  const [statusIsError, setStatusIsError] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isOffline, setIsOffline] = useState(false);
  const [queuedOps, setQueuedOps] = useState(0);

  // ── Create Drone wizard ────────────────────────────────────────────────────
  const [createStep, setCreateStep] = useState<1 | 2 | 3>(1);
  const [createBasicData, setCreateBasicData] = useState<Record<string, string>>({});
  const [pendingComponents, setPendingComponents] = useState<PendingComponent[]>([]);
  // Catalogue state
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [catalogue, setCatalogue] = useState<CatalogueProduct[]>([]);
  const [catFilter, setCatFilter] = useState<{ mfr: string; role: string; search: string }>({ mfr: '', role: '', search: '' });
  const [catLoaded, setCatLoaded] = useState(false);
  const [selectedCatProduct, setSelectedCatProduct] = useState<CatalogueProduct | null>(null);
  const [appStats, setAppStats] = useState<AppStats | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [addingRole, setAddingRole] = useState<ComponentRole | null>(null);
  // Custom part form
  const [addingCustom, setAddingCustom] = useState(false);
  const [customRole, setCustomRole] = useState<ComponentRole>('OTHER');
  const [customName, setCustomName] = useState('');
  const [customMfr, setCustomMfr] = useState('');
  const [customNotes, setCustomNotes] = useState('');
  const [customQty, setCustomQty] = useState(1);
  // Hardware history panel for a selected drone
  const [showHwHistory, setShowHwHistory] = useState<number | null>(null); // drone id
  const [hwHistory, setHwHistory] = useState<InstalledComponent[]>([]);
  const [droneTab, setDroneTab] = useState<'snapshots' | 'flight-log' | 'maintenance' | 'compare' | 'checklist'>('snapshots');
  // Checklist state
  const [checklistItems, setChecklistItems] = useState<Record<number, PreflightItem[]>>({});
  const [checklistChecked, setChecklistChecked] = useState<Record<string, boolean>>({});
  // Maintenance form type
  const [newMaintEventType, setNewMaintEventType] = useState('general');

  const [qrModal, setQrModal] = useState<QrModalState | null>(null);
  const [spareStock, setSpareStock] = useState<SpareStock[]>([]);
  const [lastCopiedSection, setLastCopiedSection] = useState<string | null>(null);
  const [droneToConfirmDelete, setDroneToConfirmDelete] = useState<number | null>(null);
  const [batteryToConfirmDelete, setBatteryToConfirmDelete] = useState<number | null>(null);
  const [lastCopiedFileId, setLastCopiedFileId] = useState<number | null>(null);

  function setOk(msg: string) { setStatusIsError(false); setStatus(msg); }
  function setErr(msg: string) { setStatusIsError(true); setStatus(msg); }

  function pickDefaultSnapshot(drone: Drone): Snapshot | null {
    // Prefer: current → known-good → newest
    return (
      drone.snapshots.find((s) => s.is_current) ??
      drone.snapshots.find((s) => s.is_known_good) ??
      drone.snapshots[0] ??
      null
    );
  }

  const loadDrones = useCallback(async (preferredDroneId?: number) => {
    const nextDrones = await apiFetch<Drone[]>('/api/drones');
    setDrones(nextDrones);
    if (!nextDrones.length) {
      setSelectedDroneId(null);
      setSelectedSnapshotId(null);
      setRawSnapshot(null);
      setOk('No drones yet. Create the first one below.');
      return;
    }
    const nextDroneId = preferredDroneId ?? selectedDroneId ?? nextDrones[0].id;
    const resolvedDrone = nextDrones.find((item) => item.id === nextDroneId) ?? nextDrones[0];
    setSelectedDroneId(resolvedDrone.id);
    const preferred = pickDefaultSnapshot(resolvedDrone);
    const nextSnapshotId = preferred?.id ?? null;
    setSelectedSnapshotId(nextSnapshotId);
    setOk(`Loaded ${nextDrones.length} drone profile(s).`);
    if (nextSnapshotId) {
      const raw = await apiFetch<RawSnapshotResponse>(`/api/snapshots/${nextSnapshotId}/raw`);
      setRawSnapshot(raw);
    } else {
      setRawSnapshot(null);
    }
  }, [selectedDroneId]);

  useEffect(() => {
    startTransition(() => {
      Promise.all([
        loadDrones().catch((error: Error) => setErr((error as Error).message)),
        apiFetch<Battery[]>('/api/batteries').then(setBatteries).catch(() => {}),
        apiFetch<SpareStock[]>('/api/spare-stock').then(setSpareStock).catch(() => {}),
      ]);
    });
  }, []);
  useEffect(() => {
    apiFetch<AppStats>('/api/stats').then(setAppStats).catch(() => {});
  }, [drones, batteries]);

  // ── Online/offline detection + SW sync listener ────────────────────────────
  useEffect(() => {
    const onOnline  = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    setIsOffline(!navigator.onLine);
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    // Listen for background sync completion from service worker
    (window as unknown as Record<string, unknown>).__fpvSyncComplete = (remaining: number) => {
      setQueuedOps(remaining);
      if (remaining === 0) {
        void loadDrones(selectedDroneId ?? undefined);
        apiFetch<Battery[]>('/api/batteries').then(setBatteries).catch(() => {});
        setOk('Synced queued operations.');
      }
    };
    return () => {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  async function loadChecklist(droneId: number) {
    try {
      const items = await apiFetch<PreflightItem[]>(`/api/drones/${droneId}/checklist`);
      setChecklistItems(prev => ({ ...prev, [droneId]: items }));
    } catch (_e) {
      // checklist may be empty for new drones
    }
  }

  async function loadCatalogue(): Promise<CatalogueProduct[]> {
    if (catLoaded) return catalogue;
    try {
      const [mfrs, prods] = await Promise.all([
        apiFetch<Manufacturer[]>('/api/manufacturers'),
        apiFetch<CatalogueProduct[]>('/api/products'),
      ]);
      setManufacturers(mfrs);
      setCatalogue(prods);
      setCatLoaded(true);
      return prods;
    } catch (_e) {
      // catalogue may be empty — that's ok
      setCatLoaded(true);
      return [];
    }
  }

  function addPendingComponent(product: CatalogueProduct | null, variantId: number | null, role: ComponentRole, qty: number, customN?: string, customM?: string, customNts?: string) {
    const _key = `${role}-${Date.now()}`;
    const display_name = product ? product.name : (customN ?? '');
    const display_mfr = product?.manufacturer?.name ?? customM ?? null;
    const variantObj = variantId ? (product?.variants.find(v => v.id === variantId) ?? null) : null;
    const fullDisplayName = variantObj ? `${display_name} (${variantObj.name})` : display_name;
    setPendingComponents(prev => [...prev, {
      _key,
      component_role: role,
      product_id: product?.id ?? null,
      product_variant_id: variantId,
      custom_name: product ? null : (customN ?? null),
      custom_manufacturer: product ? null : (customM ?? null),
      custom_notes: customNts ?? null,
      quantity: qty,
      display_name: fullDisplayName,
      display_mfr,
    }]);
  }

  function removePendingComponent(key: string) {
    setPendingComponents(prev => prev.filter(c => c._key !== key));
  }

  function resetWizard() {
    setCreateStep(1);
    setCreateBasicData({});
    setPendingComponents([]);
    setSelectedCatProduct(null);
    setSelectedVariantId(null);
    setAddingRole(null);
    setAddingCustom(false);
    setCustomName('');
    setCustomMfr('');
    setCustomNotes('');
    setCustomQty(1);
    setCatFilter({ mfr: '', role: '', search: '' });
  }



  const selectedDrone = drones.find((drone) => drone.id === selectedDroneId) ?? null;
  const selectedSnapshot = selectedDrone?.snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;

  async function submitJson<T>(path: string, payload: object, successMessage: string, preferredDroneId?: number) {
    setOk('Saving...');
    try {
      await apiFetch<T>(path, { method: 'POST', body: JSON.stringify(payload) });
      await loadDrones(preferredDroneId);
      setOk(successMessage);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleCreateDrone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createStep === 1) {
      // Save Step 1 data and advance to Step 2
      const form = event.currentTarget;
      const formData = new FormData(form);
      const data: Record<string, string> = {};
      formData.forEach((v, k) => { data[k] = v as string; });
      setCreateBasicData(data);
      setCreateStep(2);
      void loadCatalogue();
      return;
    }
    // Step 3: Final submission
    const auwRaw = createBasicData['auw_grams'];
    try {
      const drone = await apiFetch<Drone>('/api/drones', {
        method: 'POST',
        body: JSON.stringify({
          name: createBasicData['name'],
          frame: createBasicData['frame'] || null,
          stack: createBasicData['stack'] || null,
          motors: createBasicData['motors'] || null,
          props: createBasicData['props'] || null,
          notes: createBasicData['notes'] || null,
          status: createBasicData['status'] || 'flyable',
          auw_grams: auwRaw ? parseInt(auwRaw, 10) : null,
          fc_target: createBasicData['fc_target'] || null,
          radio_link: createBasicData['radio_link'] || null,
          video_system: createBasicData['video_system'] || null,
          image_url: createBasicData['image_url'] || null,
          category: createBasicData['category'] || null,
          operator_id: createBasicData['operator_id'] || null,
          registration_country: createBasicData['registration_country'] || null,
          registration_expiry: createBasicData['registration_expiry'] || null,
          remote_id_module: createBasicData['remote_id_module'] || null,
          create_default_build: pendingComponents.length > 0,
          installed_components: pendingComponents.map(c => ({
            component_role: c.component_role,
            product_id: c.product_id,
            product_variant_id: c.product_variant_id,
            custom_name: c.custom_name,
            custom_manufacturer: c.custom_manufacturer,
            custom_notes: c.custom_notes,
            quantity: c.quantity,
          })),
        }),
      });
      resetWizard();
      const preferredId = selectedDroneId ?? drone.id;
      await loadDrones(preferredId);
      setOk(`Created drone ${drone.name} with ${pendingComponents.length} component(s).`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleCreateSnapshot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDrone) {
      setErr('Select a drone first.');
      return;
    }
    const form = event.currentTarget;
    const formData = new FormData(form);
    await submitJson(
      `/api/drones/${selectedDrone.id}/snapshots`,
      {
        name: formData.get('name'),
        betaflight_version: formData.get('betaflight_version') || null,
        notes: formData.get('notes') || null,
      },
      'Snapshot created.',
      selectedDrone.id,
    );
    form.reset();
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDrone) {
      setErr('Select a drone first.');
      return;
    }
    const form = event.currentTarget;
    const formData = new FormData(form);
    // File input always returns a File object; check size to detect empty selection
    const fileEntry = formData.get('file') as File | null;
    const hasFile = fileEntry instanceof File && fileEntry.size > 0;
    const rawText = (formData.get('rawText') as string | null)?.trim() ?? '';
    if (!hasFile && !rawText) {
      setErr('Choose a file or paste raw CLI text.');
      return;
    }
    // Strip empty file so backend receives only what was actually provided
    if (!hasFile) formData.delete('file');
    // Convert empty snapshotId to nothing so backend receives null, not empty string
    const snapshotIdRaw = formData.get('snapshotId') as string | null;
    if (!snapshotIdRaw) formData.delete('snapshotId');
    setOk('Uploading...');
    try {
      await apiFetch(`/api/drones/${selectedDrone.id}/uploads`, { method: 'POST', body: formData });
      form.reset();
      await loadDrones(selectedDrone.id);
      setOk('Upload stored. BF version auto-detected from file header if present.');
    } catch (error) {
      setErr(`Upload failed: ${(error as Error).message}`);
    }
  }

  async function handleCreateBattery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setOk('Saving battery...');
    try {
      const irCells: Record<string, number | null> = {};
      [1,2,3,4,5,6].forEach(n => {
        const v = formData.get(`ir_c${n}_mohm`) as string;
        irCells[`ir_c${n}_mohm`] = v ? parseInt(v, 10) : null;
      });
      const assignedDrone = formData.get('assigned_drone_id') as string;
      const battery = await apiFetch<Battery>('/api/batteries', {
        method: 'POST',
        body: JSON.stringify({
          label: formData.get('label'),
          cell_count: parseInt(formData.get('cell_count') as string, 10),
          capacity_mah: parseInt(formData.get('capacity_mah') as string, 10),
          chemistry: formData.get('chemistry') || 'lipo',
          cycle_count: parseInt((formData.get('cycle_count') as string) || '0', 10),
          purchase_date: formData.get('purchase_date') || null,
          notes: formData.get('notes') || null,
          assigned_drone_id: assignedDrone ? parseInt(assignedDrone, 10) : null,
          ...irCells,
        }),
      });
      form.reset();
      const data = await apiFetch<Battery[]>('/api/batteries');
      setBatteries(data);
      setOk(`Battery ${battery.label} added.`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function incrementCycles(batteryId: number, currentCycles: number) {
    try {
      await apiFetch(`/api/batteries/${batteryId}`, {
        method: 'PATCH',
        body: JSON.stringify({ cycle_count: currentCycles + 1 }),
      });
      const data = await apiFetch<Battery[]>('/api/batteries');
      setBatteries(data);
      setOk('Cycle count updated.');
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function deleteBattery(batteryId: number, label: string) {
    setBatteryToConfirmDelete(null);
    try {
      await apiFetch(`/api/batteries/${batteryId}`, { method: 'DELETE' });
      setBatteries((prev) => prev.filter((b) => b.id !== batteryId));
      setOk(`Battery ${label} removed.`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleCreateNote(event: FormEvent<HTMLFormElement>, type: 'flights' | 'maintenance') {
    event.preventDefault();
    if (!selectedDrone) {
      setErr('Select a drone first.');
      return;
    }
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload: Record<string, unknown> = {
      title: formData.get('title'),
      note: formData.get('note'),
    };
    if (type === 'flights') {
      const battId = formData.get('battery_id');
      const dur = formData.get('duration_minutes');
      const pct = formData.get('battery_used_percent');
      if (battId) payload.battery_id = Number(battId);
      if (dur) payload.duration_minutes = Number(dur);
      if (pct) payload.battery_used_percent = Number(pct);
      const fdate = formData.get('flight_date') as string;
      if (fdate) payload.flight_date = fdate;
      const loc = formData.get('location') as string;
      if (loc) payload.location = loc;
      const wind = formData.get('wind_speed_kmh') as string;
      if (wind) payload.wind_speed_kmh = Number(wind);
      const temp = formData.get('temperature_c') as string;
      if (temp) payload.temperature_c = Number(temp);
      payload.outcome = (formData.get('outcome') as string) || 'ok';
      const mtemps = (['m1','m2','m3','m4'] as const).map(m => (formData.get(`motor_temp_${m}`) as string) || 'ok').join(',');
      if (mtemps !== 'ok,ok,ok,ok') payload.motor_temps = mtemps;
      const vafter = formData.get('battery_voltage_after') as string;
      if (vafter) payload.battery_voltage_after = parseFloat(vafter);
    } else {
      const evType = formData.get('event_type') as string || 'general';
      payload.event_type = evType;
      const damageItems = formData.get('damage_items');
      if (damageItems) payload.damage_items = damageItems;
      const cost = formData.get('repair_cost_pln');
      if (cost) payload.repair_cost_pln = Number(cost);
      const severity = formData.get('crash_severity') as string;
      if (severity) payload.crash_severity = severity;
      // Collect spare parts used
      const spareParts: Array<{spare_stock_id: number; qty: number}> = [];
      spareStock.forEach(item => {
        const qtyStr = formData.get(`spare_qty_${item.id}`) as string;
        const qty = parseInt(qtyStr || '0', 10);
        if (qty > 0) spareParts.push({ spare_stock_id: item.id, qty });
      });
      if (spareParts.length > 0) payload.spare_parts_used = JSON.stringify(spareParts);
    }
    await submitJson(
      `/api/drones/${selectedDrone.id}/${type}`,
      payload,
      type === 'flights' ? 'Flight note added.' : 'Maintenance event added.',
      selectedDrone.id,
    );
    form.reset();
    setNewMaintEventType('general');
  }

  async function markSnapshot(snapshotId: number, mode: 'current' | 'known-good') {
    if (!selectedDrone) return;
    setOk('Updating snapshot marker...');
    try {
      await apiFetch(`/api/snapshots/${snapshotId}/${mode === 'current' ? 'mark-current' : 'mark-known-good'}`, {
        method: 'POST',
      });
      await loadDrones(selectedDrone.id);
      setOk(mode === 'current' ? 'Current snapshot updated.' : 'Known-good snapshot updated.');
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function openRawSnapshot(snapshotId: number, snapshotName?: string) {
    setSelectedSnapshotId(snapshotId);
    try {
      const raw = await apiFetch<RawSnapshotResponse>(`/api/snapshots/${snapshotId}/raw`);
      setRawSnapshot(raw);
      setOk(`Viewing raw: ${snapshotName ?? snapshotId}.`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleDeleteNote(droneId: number, noteId: number, type: 'flights' | 'maintenance') {
    if (!confirm('Delete this note permanently?')) return;
    try {
      await apiFetch(`/api/drones/${droneId}/${type}/${noteId}`, { method: 'DELETE' });
      await loadDrones(droneId);
      setOk('Note deleted.');
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleUpdateNote(event: FormEvent<HTMLFormElement>, droneId: number, noteId: number, type: 'flights' | 'maintenance') {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      await apiFetch(`/api/drones/${droneId}/${type}/${noteId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: formData.get('title'), note: formData.get('note') }),
      });
      setEditingNoteId(null);
      setEditingNoteTab(null);
      await loadDrones(droneId);
      setOk('Note updated.');
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleUpdateSnapshot(event: FormEvent<HTMLFormElement>, snapshotId: number, droneId: number) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      await apiFetch(`/api/snapshots/${snapshotId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: formData.get('name') || undefined,
          betaflight_version: formData.get('betaflight_version') || null,
          notes: formData.get('notes') || null,
        }),
      });
      setEditSnapshotId(null);
      await loadDrones(droneId);
      setOk('Snapshot updated.');
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleQuickStatus(drone: Drone, newStatus: DroneStatus) {
    try {
      await apiFetch<Drone>(`/api/drones/${drone.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      await loadDrones(drone.id);
      setOk(`${drone.name} status → ${STATUS_META[newStatus].label}`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  function handleExportDrone(drone: Drone) {
    const url = `${apiBase}/api/drones/${drone.id}/export`;
    const link = document.createElement('a');
    link.href = url;
    link.download = `${drone.slug}-export.json`;
    link.click();
  }

  async function applyTemplate(template: DroneTemplate) {
    setShowTemplates(false);
    const nameInput = document.querySelector<HTMLInputElement>('form input[name="name"]');
    if (nameInput) {
      nameInput.value = `${template.brand} ${template.model}`;
      (document.querySelector<HTMLInputElement>('form input[name="frame"]') || {} as HTMLInputElement).value = template.frame_name || '';
      (document.querySelector<HTMLInputElement>('form input[name="stack"]') || {} as HTMLInputElement).value = template.stack || '';
      (document.querySelector<HTMLInputElement>('form input[name="motors"]') || {} as HTMLInputElement).value = template.motors || '';
      (document.querySelector<HTMLInputElement>('form input[name="props"]') || {} as HTMLInputElement).value = template.props || '';
      (document.querySelector<HTMLInputElement>('form input[name="fc_target"]') || {} as HTMLInputElement).value = template.fc_target || '';
      (document.querySelector<HTMLInputElement>('form input[name="auw_grams"]') || {} as HTMLInputElement).value = template.auw_grams ? String(template.auw_grams) : '';
      (document.querySelector<HTMLInputElement>('form input[name="image_url"]') || {} as HTMLInputElement).value = template.image_url || '';
      (document.querySelector<HTMLInputElement>('form input[name="category"]') || {} as HTMLInputElement).value = template.category || '';
      (document.querySelector<HTMLTextAreaElement>('form textarea[name="notes"]') || {} as HTMLTextAreaElement).value = template.notes || '';
      const radioSelect = document.querySelector<HTMLSelectElement>('form select[name="radio_link"]');
      if (radioSelect && template.radio_link) radioSelect.value = template.radio_link;
      const videoSelect = document.querySelector<HTMLSelectElement>('form select[name="video_system"]');
      if (videoSelect && template.video_system) videoSelect.value = template.video_system;
    }

    // Auto-populate pendingComponents from seed data
    const preset = (seedJson as { presets: Array<{ brand: string; model: string; parts: Array<{ component_role: string; name: string; quantity: number; manufacturer_hint: string | null }> }> }).presets
      .find(p => p.brand === template.brand && p.model === template.model);
    if (!preset) return;

    // Load catalogue products so we can match by name+role
    const products = await loadCatalogue();

    setPendingComponents([]);
    const newPending: PendingComponent[] = [];
    for (const part of preset.parts) {
      const role = part.component_role as ComponentRole;
      // Try exact name + role match against catalogue
      const catProduct = products.find(
        p => p.name === part.name && p.component_role === part.component_role
      ) ?? null;
      const _key = `${role}-${Date.now()}-${Math.random()}`;
      if (catProduct) {
        newPending.push({
          _key,
          component_role: role,
          product_id: catProduct.id,
          product_variant_id: null,
          custom_name: null,
          custom_manufacturer: null,
          custom_notes: null,
          quantity: part.quantity,
          display_name: catProduct.name,
          display_mfr: catProduct.manufacturer?.name ?? null,
        });
      } else {
        newPending.push({
          _key,
          component_role: role,
          product_id: null,
          product_variant_id: null,
          custom_name: part.name,
          custom_manufacturer: part.manufacturer_hint ?? template.brand,
          custom_notes: null,
          quantity: part.quantity,
          display_name: part.name,
          display_mfr: part.manufacturer_hint ?? template.brand,
        });
      }
    }
    setPendingComponents(newPending);
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setOk('Copied to clipboard.');
    } catch {
      setErr('Clipboard access denied — select and copy manually.');
    }
  }

  function copySectionAsCLI(entries: Array<{key: string; value: string}>, sectionKey: string) {
    const lines = entries.map(({key, value}) => `set ${key} = ${value}`).join('\n');
    void copyToClipboard(lines).then(() => {
      setLastCopiedSection(sectionKey);
      setTimeout(() => setLastCopiedSection(null), 2000);
    });
  }

  async function handleUpdateDrone(event: FormEvent<HTMLFormElement>, droneId: number) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const auwRaw = formData.get('auw_grams') as string | null;
    setOk('Saving...');
    try {
      await apiFetch<Drone>(`/api/drones/${droneId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: formData.get('name') || undefined,
          frame: formData.get('frame') || null,
          stack: formData.get('stack') || null,
          motors: formData.get('motors') || null,
          props: formData.get('props') || null,
          notes: formData.get('notes') || null,
          status: formData.get('status') || undefined,
          auw_grams: auwRaw ? parseInt(auwRaw, 10) : null,
          fc_target: formData.get('fc_target') || null,
          radio_link: formData.get('radio_link') || null,
          video_system: formData.get('video_system') || null,
          image_url: formData.get('image_url') || null,
          category: formData.get('category') || null,
          operator_id: formData.get('operator_id') || null,
          registration_country: formData.get('registration_country') || null,
          registration_expiry: formData.get('registration_expiry') || null,
          remote_id_module: formData.get('remote_id_module') || null,
        }),
      });
      setEditDroneId(null);
      await loadDrones(droneId);
      setOk('Drone updated.');
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleDeleteDrone(drone: Drone) {
    setDroneToConfirmDelete(null);
    try {
      await apiFetch(`/api/drones/${drone.id}`, { method: 'DELETE' });
      setSelectedDroneId(null);
      setEditDroneId(null);
      setRawSnapshot(null);
      await loadDrones();
      setOk(`Deleted drone ${drone.name}.`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleDeleteSnapshot(snapshot: Snapshot) {
    if (!confirm(`Delete snapshot "${snapshot.name}" and all its files permanently?`)) return;
    if (!selectedDrone) return;
    try {
      await apiFetch(`/api/snapshots/${snapshot.id}`, { method: 'DELETE' });
      if (selectedSnapshotId === snapshot.id) {
        setSelectedSnapshotId(null);
        setRawSnapshot(null);
      }
      await loadDrones(selectedDrone.id);
      setOk(`Snapshot "${snapshot.name}" deleted.`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleDeleteFile(file: StoredFile) {
    if (!confirm(`Delete file "${file.original_filename || file.role}" permanently?`)) return;
    if (!selectedDrone) return;
    try {
      await apiFetch(`/api/files/${file.id}`, { method: 'DELETE' });
      await loadDrones(selectedDrone.id);
      // Refresh raw view
      if (selectedSnapshotId) {
        const raw = await apiFetch<RawSnapshotResponse>(`/api/snapshots/${selectedSnapshotId}/raw`);
        setRawSnapshot(raw);
      }
      setOk(`File deleted.`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleCompare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const left = Number(formData.get('left_snapshot_id'));
    const right = Number(formData.get('right_snapshot_id'));
    if (!left || !right) {
      setCompareResult(null);
      setErr('Choose two snapshots to compare.');
      return;
    }
    if (left === right) {
      setCompareResult(null);
      setErr('Choose two different snapshots to compare.');
      return;
    }
    setOk('Comparing snapshots...');
    try {
      const result = await apiFetch<CompareResponse>('/api/snapshots/compare', {
        method: 'POST',
        body: JSON.stringify({ left_snapshot_id: left, right_snapshot_id: right }),
      });
      setCompareResult(result);
      setOk(`Compared snapshots. Added: ${result.added_lines}, removed: ${result.removed_lines}.`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  return (
    <main className="page-shell">
      {isOffline && (
        <div style={{background:'rgba(240,168,48,0.12)',borderBottom:'1px solid rgba(240,168,48,0.3)',padding:'6px 20px',display:'flex',alignItems:'center',gap:'10px',fontSize:'0.82rem',color:'#f0a830',position:'sticky',top:0,zIndex:100}}>
          <span>📡 Offline — showing cached data</span>
          {queuedOps > 0 && <span style={{marginLeft:'auto'}}>⏳ {queuedOps} operation{queuedOps !== 1 ? 's' : ''} queued</span>}
          {queuedOps === 0 && <span style={{marginLeft:'auto',color:'var(--text-muted)'}}>Changes will sync automatically when back online</span>}
        </div>
      )}
      <section className="hero">
        <div className="badge-row">
          <span className="badge warm">Docker Compose MVP</span>
          <span className="badge">Persistent uploads</span>
          <span className="badge">Betaflight archive</span>
        </div>
        <h1>FPV Drone Catalog for private fleets and Betaflight backups.</h1>
        <p>
          A self-hosted catalogue for drones, snapshots, raw CLI exports, flight notes, maintenance history, and
          backup-friendly file storage.
        </p>
        <div className={`status${statusIsError ? ' status-error' : ''}`}>{isPending ? 'Refreshing...' : status}</div>
      </section>

      <nav className="subnav" aria-label="Main navigation">
        <Link className={`subnav-link${isOverviewPage ? ' active' : ''}`} href="/">Overview</Link>
        <Link className={`subnav-link${isDronesPage ? ' active' : ''}`} href="/drones">Drones</Link>
        <Link className={`subnav-link${isBatteriesPage ? ' active' : ''}`} href="/batteries">Batteries</Link>
        <Link className={`subnav-link${pathname === '/catalogue' ? ' active' : ''}`} href="/catalogue">Catalogue</Link>
        <Link className={`subnav-link${pathname === '/snapshots' ? ' active' : ''}`} href="/snapshots">Snapshots</Link>
      </nav>

      {isOverviewPage && (
        <div className="overview-landing">
          <div className="stat-strip">
            <div className="stat-card">
              <span className="stat-value">{drones.length}</span>
              <span className="stat-label">Drones</span>
            </div>
            <div className="stat-card stat-green">
              <span className="stat-value">{drones.filter(d => d.status === 'flyable').length}</span>
              <span className="stat-label">Flyable</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{drones.reduce((n, d) => n + d.snapshots.length, 0)}</span>
              <span className="stat-label">Snapshots</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{batteries.length}</span>
              <span className="stat-label">Batteries</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{appStats ? String((appStats.products as number) ?? '0') : '0'}</span>
              <span className="stat-label">Parts</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{appStats ? String(((appStats.drones as Record<string, number>)?.grounded) ?? 0) : '0'}</span>
              <span className="stat-label">Grounded</span>
            </div>
          </div>

          {appStats && drones.length > 0 && (
            <div style={{display:'flex',flexWrap:'wrap',gap:'6px',margin:'0 0 14px'}}>
              {Object.entries((appStats.by_video ?? {}) as Record<string, number>).map(([system, count]) => (
                <span key={system} className="badge" style={{fontSize:'0.75rem',padding:'3px 10px'}}>{system}: <strong>{count}</strong></span>
              ))}
              {Object.entries((appStats.by_category ?? {}) as Record<string, number>).map(([category, count]) => (
                <span key={category} className="badge warm" style={{fontSize:'0.75rem',padding:'3px 10px'}}>{category.replace(/_/g, '-')}: <strong>{count}</strong></span>
              ))}
            </div>
          )}

          <div className="quick-nav">
            <Link href="/drones" className="quick-card">
              <span className="quick-icon">🚁</span>
              <span className="quick-title">Drones</span>
              <span className="quick-sub">Manage fleet, create &amp; configure drones</span>
            </Link>
            <Link href="/batteries" className="quick-card">
              <span className="quick-icon">🔋</span>
              <span className="quick-title">Batteries</span>
              <span className="quick-sub">Track LiPo / LiHV battery health &amp; cycles</span>
            </Link>
            <Link href="/catalogue" className="quick-card">
              <span className="quick-icon">📦</span>
              <span className="quick-title">Parts Catalogue</span>
              <span className="quick-sub">Browse components across manufacturers</span>
            </Link>
            <Link href="/snapshots" className="quick-card">
              <span className="quick-icon">📸</span>
              <span className="quick-title">Snapshots</span>
              <span className="quick-sub">Betaflight configs &amp; backups across all drones</span>
            </Link>
          </div>

          {spareStock.some(s => s.quantity <= s.low_stock_threshold) && (
            <div className="panel" style={{marginBottom:'12px',background:'rgba(224,64,64,0.1)',border:'1px solid rgba(224,64,64,0.3)'}}>
              <strong style={{color:'#e04040'}}>⚠ Low spare parts: </strong>
              {spareStock.filter(s => s.quantity <= s.low_stock_threshold).map(s => `${s.part_name} (${s.quantity})`).join(' · ')}
            </div>
          )}

          {(() => {
            const today = new Date();
            const expiring = drones.filter(d => {
              if (!d.registration_expiry) return false;
              const exp = new Date(d.registration_expiry);
              const daysLeft = (exp.getTime() - today.getTime()) / 86_400_000;
              return daysLeft <= 30;
            });
            return expiring.length > 0 ? (
              <div className="panel" style={{marginBottom:'12px',background:'rgba(240,168,48,0.1)',border:'1px solid rgba(240,168,48,0.3)'}}>
                <strong style={{color:'#f0a830'}}>⚠ EASA registration expiring: </strong>
                {expiring.map(d => {
                  const exp = new Date(d.registration_expiry!);
                  const daysLeft = Math.ceil((exp.getTime() - today.getTime()) / 86_400_000);
                  return <span key={d.id} style={{marginRight:'10px'}}>{d.name} <span style={{color: daysLeft <= 0 ? '#e04040' : '#f0a830'}}>{daysLeft <= 0 ? '(expired)' : `(${daysLeft}d)`}</span></span>;
                })}
              </div>
            ) : null;
          })()}

          {(() => {
            const stale = batteries.filter(b => {
              const lastUse = b.last_charged_at ? new Date(b.last_charged_at) : (b.updated_at ? new Date(b.updated_at) : null);
              if (!lastUse || b.batt_status !== 'active') return false;
              return (Date.now() - lastUse.getTime()) / 86_400_000 > 14;
            });
            return stale.length > 0 ? (
              <div className="panel" style={{marginBottom:'12px',background:'rgba(96,160,240,0.1)',border:'1px solid rgba(96,160,240,0.3)'}}>
                <strong style={{color:'#60a0f0'}}>🔋 Storage voltage check: </strong>
                {stale.length} {stale.length === 1 ? 'battery' : 'batteries'} unused for 14+ days — check storage voltage (3.85V/cell). {stale.map(b => b.label).join(', ')}
              </div>
            ) : null;
          })()}

          {drones.length > 0 && (() => {
            const flyable = drones.filter(d => d.status === 'flyable');
            const readyNow = flyable.filter(d => getDroneReadiness(d) === 'ready');
            const activeBats = batteries.filter(b => b.batt_status === 'active');
            return (
              <div className="panel" style={{marginBottom:'12px'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'8px'}}>
                  <h3 style={{margin:0}}>Ready to fly</h3>
                  <span style={{fontSize:'0.8rem',color:'var(--text-muted)'}}>{readyNow.length}/{flyable.length} flyable drones ready · {activeBats.length} active batteries</span>
                </div>
                <div style={{display:'flex',flexWrap:'wrap',gap:'6px'}}>
                  {flyable.length === 0 && <span style={{fontSize:'0.85rem',color:'var(--text-muted)'}}>No flyable drones in fleet.</span>}
                  {flyable.map(d => {
                    const r = getDroneReadiness(d);
                    const color = r === 'ready' ? '#4fc38a' : r === 'needs_backup' ? '#60a0f0' : '#f0a830';
                    const icon = r === 'ready' ? '✓' : r === 'needs_backup' ? '⚡' : '⚠';
                    return (
                      <Link key={d.id} href="/drones"
                        style={{display:'inline-flex',alignItems:'center',gap:'5px',padding:'4px 10px',borderRadius:'6px',
                          border:`1px solid ${color}30`,background:`${color}10`,color,fontSize:'0.8rem',textDecoration:'none'}}>
                        {icon} {d.name}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {drones.length > 0 && (
            <div className="panel" style={{marginBottom:'18px'}}>
              {(() => {
                const actionDrones = [...drones]
                  .filter(drone => getDroneReadiness(drone) !== 'ready')
                  .sort((a, b) => getDroneIssues(b).length - getDroneIssues(a).length);
                const visibleDrones = actionDrones.slice(0, 4);
                const hiddenCount = actionDrones.length - visibleDrones.length;
                return (
                  <>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'8px',marginBottom:'10px'}}>
                      <h3 style={{margin:0}}>
                        Action queue
                        {actionDrones.length > 0 && <span style={{fontSize:'0.8rem',fontWeight:400,color:'var(--text-muted)',marginLeft:'5px'}}>({actionDrones.length})</span>}
                      </h3>
                      <span style={{fontSize:'0.8rem',color:'var(--text-muted)'}}>Most issues first</span>
                    </div>
                    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'10px'}}>
                      {actionDrones.length === 0 && (
                        <div style={{color:'var(--text-muted)',fontSize:'0.85rem'}}>All drones are ready or only need routine logging.</div>
                      )}
                      {visibleDrones.map(drone => {
                        const readiness = getDroneReadiness(drone);
                        const meta = READINESS_META[readiness];
                        const issues = getDroneIssues(drone);
                        return (
                          <div key={drone.id} className="card" style={{textAlign:'left'}}>
                            <div style={{display:'flex',justifyContent:'space-between',gap:'8px',alignItems:'flex-start',marginBottom:'6px'}}>
                              <strong style={{lineHeight:1.3}}>{drone.name}</strong>
                              <span className="badge" style={{background:meta.bg,color:meta.color,whiteSpace:'nowrap'}}>{meta.label}</span>
                            </div>
                            <div style={{display:'flex',flexWrap:'wrap',gap:'5px',marginBottom:'8px'}}>
                              {issues.map(issue => <span key={issue} className="badge" style={{fontSize:'0.72rem'}}>{issue}</span>)}
                            </div>
                            <div style={{display:'flex',gap:'6px',flexWrap:'wrap'}}>
                              <button className="button ghost" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => { setSelectedDroneId(drone.id); router.push('/drones'); }}>Open drone</button>
                              <button className="button ghost" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => setQrModal({entityType:'drone',id:drone.id,label:drone.name})}>QR</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {hiddenCount > 0 && (
                      <p style={{fontSize:'0.8rem',color:'var(--text-muted)',margin:'8px 0 0'}}>
                        +{hiddenCount} more — <Link href="/drones" style={{color:'var(--accent)'}}>view all on Drones page</Link>
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {drones.length > 0 && (
            <div className="recent-section">
              <div className="recent-header">
                <h3>Recent Drones</h3>
                <Link href="/drones" className="see-all-link">View all {drones.length} →</Link>
              </div>
              <div className="recent-list">
                {[...drones].sort((a, b) => (a.status === 'flyable' ? 0 : 1) - (b.status === 'flyable' ? 0 : 1)).slice(0, 6).map(d => (
                  <Link key={d.id} href="/drones" className="recent-item">
                    {d.image_url
                      ? <img src={d.image_url} alt="" className="recent-thumb" />
                      : <div className="recent-thumb-placeholder">🚁</div>}
                    <div className="recent-item-info">
                      <span className="recent-name">{d.name}</span>
                      <span className="recent-meta" style={{background: STATUS_META[d.status].bg, color: STATUS_META[d.status].color}}>
                        {STATUS_META[d.status].label}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showDroneSections && (
      <section className="hero-grid">
        <article className="panel span-4">
          <div style={{display:'flex',alignItems:'flex-start',gap:'6px',marginBottom:'12px'}}>
            {([1,2,3] as const).map(s => {
              const stepLabels = ['Basic Info', 'Hardware / Parts', 'Review & Save'];
              return (
                <Fragment key={s}>
                  <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:'3px',flexShrink:0}}>
                    <div style={{width:24,height:24,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',
                      fontSize:'0.75rem',fontWeight:700,
                      background: createStep === s ? 'var(--accent)' : createStep > s ? '#4fc38a' : 'var(--surface2)',
                      color: createStep >= s ? '#fff' : 'var(--text-muted)'}}>
                      {createStep > s ? '✓' : s}
                    </div>
                    <span style={{fontSize:'0.65rem',color: createStep === s ? 'var(--text)' : 'var(--text-muted)',whiteSpace:'nowrap'}}>
                      {stepLabels[s - 1]}
                    </span>
                  </div>
                  {s < 3 && <div style={{flex:1,height:2,background: createStep > s ? '#4fc38a' : 'var(--border)',marginTop:'11px'}} />}
                </Fragment>
              );
            })}
          </div>

          <h2 style={{marginTop:0}}>
            {createStep === 1 ? 'Create drone' : createStep === 2 ? 'Select parts' : 'Review & Save'}
          </h2>

          {createStep === 1 && (
            <form className="stack" onSubmit={(event) => void handleCreateDrone(event)}>
              <label className="field">
                <span>Name</span>
                <input name="name" placeholder="Apex 5" required defaultValue={createBasicData['name'] ?? ''} />
              </label>
              <div className="two-col">
                <label className="field"><span>Frame</span><input name="frame" placeholder="5 inch freestyle" defaultValue={createBasicData['frame'] ?? ''} /></label>
                <label className="field"><span>Stack</span><input name="stack" placeholder="F7 55A" defaultValue={createBasicData['stack'] ?? ''} /></label>
                <label className="field"><span>Motors</span><input name="motors" placeholder="2207 1960KV" defaultValue={createBasicData['motors'] ?? ''} /></label>
                <label className="field"><span>Props</span><input name="props" placeholder="5.1x3.6x3" defaultValue={createBasicData['props'] ?? ''} /></label>
              </div>
              <div className="two-col">
                <label className="field">
                  <span>Status</span>
                  <select name="status" defaultValue={createBasicData['status'] ?? 'flyable'}>
                    <option value="flyable">Flyable</option>
                    <option value="needs_repair">Needs repair</option>
                    <option value="grounded_crash">Crashed / grounded</option>
                    <option value="in_build">In build</option>
                    <option value="retired">Retired</option>
                    <option value="for_parts">For parts</option>
                  </select>
                </label>
                <label className="field"><span>AUW (grams)</span><input name="auw_grams" type="number" placeholder="380" min="1" max="25000" defaultValue={createBasicData['auw_grams'] ?? ''} /></label>
              </div>
              <div className="two-col">
                <label className="field"><span>FC target</span><input name="fc_target" placeholder="SPEEDYBEEF405" defaultValue={createBasicData['fc_target'] ?? ''} /></label>
                <label className="field">
                  <span>Radio link</span>
                  <select name="radio_link" defaultValue={createBasicData['radio_link'] ?? ''}>
                    <option value="">Unknown</option>
                    <option value="ELRS 2.4GHz">ELRS 2.4 GHz</option>
                    <option value="ELRS 900MHz">ELRS 900 MHz</option>
                    <option value="TBS Crossfire">TBS Crossfire</option>
                    <option value="TBS Tracer">TBS Tracer</option>
                    <option value="FrSky D16">FrSky D16</option>
                    <option value="FrSky ACCST">FrSky ACCST</option>
                    <option value="Spektrum">Spektrum</option>
                    <option value="Other">Other</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Video system</span>
                <select name="video_system" defaultValue={createBasicData['video_system'] ?? ''}>
                  <option value="">Unknown</option>
                  <option value="Analog">Analog</option>
                  <option value="DJI O3">DJI O3</option>
                  <option value="DJI O4">DJI O4</option>
                  <option value="Avatar HD">Avatar HD (Walksnail)</option>
                  <option value="HDZero">HDZero</option>
                  <option value="Walksnail">Walksnail</option>
                </select>
              </label>
              <details>
                <summary style={{cursor:'pointer',color:'var(--muted)',fontSize:'0.88rem',marginBottom:'6px'}}>EU/EASA regulatory fields</summary>
                <div className="two-col" style={{marginTop:'8px'}}>
                  <label className="field"><span>Operator ID</span><input name="operator_id" placeholder="POL-1234567" defaultValue={createBasicData['operator_id'] ?? ''} /></label>
                  <label className="field"><span>Country</span><input name="registration_country" placeholder="PL" maxLength={3} defaultValue={createBasicData['registration_country'] ?? ''} /></label>
                  <label className="field"><span>Registration expiry</span><input name="registration_expiry" type="date" defaultValue={createBasicData['registration_expiry'] ?? ''} /></label>
                  <label className="field"><span>Remote ID module</span><input name="remote_id_module" placeholder="Dronetag Mini" defaultValue={createBasicData['remote_id_module'] ?? ''} /></label>
                </div>
              </details>
              <div className="two-col">
                <label className="field"><span>Category</span><input name="category" placeholder="freestyle / cinematic / long-range" defaultValue={createBasicData['category'] ?? ''} /></label>
                <label className="field"><span>Image URL (manufacturer photo)</span><input name="image_url" type="text" placeholder="https://… or /api/proxy-image?..." defaultValue={createBasicData['image_url'] ?? ''} /></label>
              </div>
              <label className="field"><span>Notes</span><textarea name="notes" placeholder="Build notes, receiver details, wiring changes..." defaultValue={createBasicData['notes'] ?? ''} /></label>
              <div className="actions">
                <button className="button" type="submit">Next: Hardware →</button>
                <button className="button ghost" type="button" title="Quick-fill form fields from a known drone model (iFlight, GEPRC, Flywoo, DeepSpaceFPV)" onClick={() => setShowTemplates(!showTemplates)}>From template</button>
              </div>
              {showTemplates && (
                <div className="edit-panel" style={{marginTop:'10px'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'10px'}}>
                    <h4 style={{margin:0,fontSize:'0.9rem'}}>Quick-fill from brand template</h4>
                    <button className="button ghost" type="button" style={{fontSize:'0.75rem',padding:'2px 8px'}}
                      onClick={() => { setShowTemplates(false); setTemplateBrand(''); setTemplateSearch(''); }}>✕ Close</button>
                  </div>
                  <div style={{display:'flex',gap:'5px',flexWrap:'wrap',marginBottom:'8px'}}>
                    {['', 'iFlight', 'GEPRC', 'Flywoo', 'DeepSpaceFPV'].map(b => (
                      <button key={b || 'all'} type="button"
                        className={`button ghost${templateBrand === b ? ' active' : ''}`}
                        style={{fontSize:'0.75rem',padding:'3px 10px'}}
                        onClick={() => setTemplateBrand(b)}>
                        {b || 'All brands'}
                      </button>
                    ))}
                  </div>
                  <input type="text" placeholder="Search model…" value={templateSearch}
                    onChange={e => setTemplateSearch(e.target.value)}
                    style={{width:'100%',marginBottom:'10px',padding:'5px 9px',borderRadius:'6px',
                      border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',
                      fontSize:'0.82rem',boxSizing:'border-box'}} />
                  {(() => {
                    const filtered = DRONE_TEMPLATES.filter(t =>
                      (!templateBrand || t.brand === templateBrand) &&
                      (!templateSearch || t.model.toLowerCase().includes(templateSearch.toLowerCase()) ||
                        t.category.toLowerCase().includes(templateSearch.toLowerCase()))
                    );
                    return (
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px',maxHeight:'340px',overflowY:'auto',paddingRight:'2px'}}>
                        {filtered.map(tpl => (
                          <button key={`${tpl.brand}-${tpl.model}`} type="button" onClick={() => applyTemplate(tpl)}
                            style={{textAlign:'left',padding:'9px 11px',borderRadius:'8px',
                              border:'1px solid var(--border)',background:'var(--surface2)',
                              cursor:'pointer',display:'flex',flexDirection:'column',gap:'3px'}}>
                            <div style={{fontSize:'0.68rem',color:'var(--accent)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.05em'}}>{tpl.brand}</div>
                            <div style={{fontSize:'0.84rem',fontWeight:600,color:'var(--text)',lineHeight:1.25}}>{tpl.model}</div>
                            <div style={{display:'flex',gap:'4px',flexWrap:'wrap',marginTop:'2px'}}>
                              <span style={{fontSize:'0.67rem',padding:'1px 5px',borderRadius:'4px',background:'rgba(255,255,255,0.07)',color:'var(--text-muted)'}}>{tpl.frame}</span>
                              {tpl.auw_grams && <span style={{fontSize:'0.67rem',padding:'1px 5px',borderRadius:'4px',background:'rgba(255,255,255,0.07)',color:'var(--text-muted)'}}>{tpl.auw_grams}g</span>}
                              {tpl.video_system && <span style={{fontSize:'0.67rem',padding:'1px 5px',borderRadius:'4px',background:'rgba(96,160,240,0.13)',color:'#60a0f0'}}>{tpl.video_system}</span>}
                            </div>
                          </button>
                        ))}
                        {filtered.length === 0 && (
                          <div style={{gridColumn:'1/-1',textAlign:'center',color:'var(--text-muted)',padding:'24px',fontSize:'0.85rem'}}>
                            No templates match.
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </form>
          )}

          {createStep === 2 && (
            <div className="stack">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:'8px',marginBottom:'2px'}}>
                <span style={{fontSize:'0.8rem',color:'var(--text-muted)'}}>Build configuration for {createBasicData['name'] || 'new drone'}</span>
                <button className="button ghost" type="button" style={{padding:'3px 8px',fontSize:'0.75rem'}} onClick={() => loadCatalogue().catch(() => {})}>↻ Reload catalogue</button>
              </div>
              <div style={{display:'flex',gap:'6px',flexWrap:'wrap'}}>
                <select value={catFilter.mfr} onChange={e => setCatFilter(prev => ({...prev, mfr: e.target.value}))}
                  style={{flex:'1 1 120px',padding:'5px 8px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}}>
                  <option value="">All manufacturers</option>
                  {manufacturers.map(m => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
                </select>
                <select value={catFilter.role} onChange={e => setCatFilter(prev => ({...prev, role: e.target.value}))}
                  style={{flex:'1 1 120px',padding:'5px 8px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}}>
                  <option value="">All roles</option>
                  {ALL_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
                <input type="text" placeholder="Search parts…" value={catFilter.search}
                  onChange={e => setCatFilter(prev => ({...prev, search: e.target.value}))}
                  style={{flex:'2 1 180px',padding:'5px 9px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}} />
              </div>
              {!catLoaded ? (
                <div style={{color:'var(--text-muted)',fontSize:'0.85rem',padding:'16px 0'}}>Loading catalogue…</div>
              ) : catalogue.length === 0 ? (
                <div style={{color:'var(--text-muted)',fontSize:'0.85rem',padding:'8px 0'}}>
                  No products in catalogue yet. Use the custom part form below, or add products via API first.
                </div>
              ) : (
                <div style={{maxHeight:240,overflowY:'auto',border:'1px solid var(--border)',borderRadius:'8px',padding:'6px'}}>
                  {catalogue
                    .filter(p => (!catFilter.role || p.component_role === catFilter.role) && (!catFilter.mfr || String(p.manufacturer?.id) === catFilter.mfr) && (!catFilter.search || p.name.toLowerCase().includes(catFilter.search.toLowerCase())))
                    .map(p => (
                      <div key={p.id} onClick={() => { setSelectedCatProduct(p); setSelectedVariantId(null); setAddingRole(p.component_role as ComponentRole); }}
                        style={{padding:'7px 10px',borderRadius:'6px',cursor:'pointer',marginBottom:'3px',border:`1px solid ${selectedCatProduct?.id === p.id ? 'var(--accent)' : 'transparent'}`,background: selectedCatProduct?.id === p.id ? 'rgba(96,160,240,0.08)' : 'transparent'}}>
                        <div style={{fontSize:'0.82rem',fontWeight:600,color:'var(--text)'}}>{p.name}</div>
                        <div style={{fontSize:'0.72rem',color:'var(--text-muted)'}}>{p.manufacturer?.name} {ROLE_LABELS[p.component_role as ComponentRole] ?? p.component_role}</div>
                      </div>
                    ))}
                </div>
              )}
              {selectedCatProduct && (
                <div style={{border:'1px solid var(--accent)',borderRadius:'8px',padding:'10px',background:'rgba(96,160,240,0.05)'}}>
                  <div style={{fontWeight:600,fontSize:'0.88rem',marginBottom:'6px'}}>{selectedCatProduct.name}</div>
                  {selectedCatProduct.variants.length > 0 && (
                    <div style={{marginBottom:'8px'}}>
                      <div style={{fontSize:'0.75rem',color:'var(--text-muted)',marginBottom:'4px'}}>Variant:</div>
                      <div style={{display:'flex',gap:'4px',flexWrap:'wrap'}}>
                        {selectedCatProduct.variants.map(v => (
                          <button key={v.id} type="button"
                            className={`button ghost${selectedVariantId === v.id ? ' active' : ''}`}
                            style={{fontSize:'0.73rem',padding:'2px 8px'}}
                            onClick={() => setSelectedVariantId(v.id)}>
                            {v.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{display:'flex',gap:'6px',alignItems:'center',flexWrap:'wrap'}}>
                    <label style={{fontSize:'0.75rem',color:'var(--text-muted)'}}>Role:</label>
                    <select value={addingRole ?? selectedCatProduct.component_role}
                      onChange={e => setAddingRole(e.target.value as ComponentRole)}
                      style={{padding:'3px 6px',borderRadius:'5px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.78rem'}}>
                      {ALL_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                    <label style={{fontSize:'0.75rem',color:'var(--text-muted)'}}>Qty:</label>
                    <input type="number" min={1} max={20} id="cat-qty-input"
                      defaultValue={ROLE_DEFAULT_QTY[addingRole ?? selectedCatProduct.component_role as ComponentRole] ?? 1}
                      style={{width:48,padding:'3px 5px',borderRadius:'5px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.78rem'}} />
                    <button className="button" type="button" style={{fontSize:'0.78rem',padding:'4px 12px'}}
                      onClick={() => {
                        const qtyEl = document.getElementById('cat-qty-input') as HTMLInputElement;
                        const qty = parseInt(qtyEl?.value || '1', 10);
                        addPendingComponent(selectedCatProduct, selectedVariantId, addingRole ?? selectedCatProduct.component_role as ComponentRole, qty);
                        setSelectedCatProduct(null);
                        setSelectedVariantId(null);
                      }}>
                      + Add
                    </button>
                  </div>
                </div>
              )}
              <div style={{borderTop:'1px solid var(--border)',paddingTop:'10px'}}>
                <button className="button ghost" type="button" style={{fontSize:'0.8rem',marginBottom:'8px'}} onClick={() => setAddingCustom(v => !v)}>
                  {addingCustom ? '▲ Cancel custom part' : '+ Add custom / unlisted part'}
                </button>
                {addingCustom && (
                  <div style={{display:'flex',flexDirection:'column',gap:'6px'}}>
                    <div style={{display:'flex',gap:'6px'}}>
                      <select value={customRole} onChange={e => setCustomRole(e.target.value as ComponentRole)}
                        style={{flex:1,padding:'5px 8px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}}>
                        {ALL_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                      <input type="number" min={1} max={20} value={customQty} onChange={e => setCustomQty(Number(e.target.value))}
                        style={{width:52,padding:'5px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}} />
                    </div>
                    <input placeholder="Part name *" value={customName} onChange={e => setCustomName(e.target.value)}
                      style={{padding:'5px 9px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}} />
                    <input placeholder="Manufacturer (optional)" value={customMfr} onChange={e => setCustomMfr(e.target.value)}
                      style={{padding:'5px 9px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}} />
                    <input placeholder="Notes (optional)" value={customNotes} onChange={e => setCustomNotes(e.target.value)}
                      style={{padding:'5px 9px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}} />
                    <button className="button" type="button" style={{alignSelf:'flex-start'}} disabled={!customName.trim()}
                      onClick={() => {
                        if (!customName.trim()) return;
                        addPendingComponent(null, null, customRole, customQty, customName.trim(), customMfr.trim() || undefined, customNotes.trim() || undefined);
                        setCustomName('');
                        setCustomMfr('');
                        setCustomNotes('');
                        setAddingCustom(false);
                      }}>
                      + Add custom part
                    </button>
                  </div>
                )}
              </div>
              {pendingComponents.length > 0 && (
                <div style={{border:'1px solid var(--border)',borderRadius:'8px',padding:'10px'}}>
                  <div style={{fontSize:'0.8rem',fontWeight:700,color:'var(--text-muted)',marginBottom:'8px'}}>SELECTED PARTS ({pendingComponents.length})</div>
                  {pendingComponents.map(c => (
                    <div key={c._key} style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'5px',padding:'5px 7px',borderRadius:'5px',background:'var(--surface2)'}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:'0.8rem',fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{c.display_name}</div>
                        <div style={{fontSize:'0.7rem',color:'var(--text-muted)'}}>
                          {ROLE_LABELS[c.component_role]} · qty {c.quantity}
                          {c.display_mfr && ` · ${c.display_mfr}`}
                        </div>
                      </div>
                      <input type="number" min={1} max={20} value={c.quantity}
                        onChange={e => setPendingComponents(prev => prev.map(x => x._key === c._key ? {...x, quantity: Number(e.target.value)} : x))}
                        style={{width:42,padding:'2px 4px',borderRadius:'4px',border:'1px solid var(--border)',background:'var(--surface)',color:'var(--text)',fontSize:'0.78rem'}} />
                      <button type="button" style={{background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:'0.9rem',padding:'0 2px'}} onClick={() => removePendingComponent(c._key)}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="actions" style={{marginTop:'8px'}}>
                <button className="button ghost" type="button" onClick={() => setCreateStep(1)}>← Back</button>
                <button className="button" type="button" onClick={() => setCreateStep(3)}>Review →</button>
              </div>
            </div>
          )}

          {createStep === 3 && (
            <form className="stack" onSubmit={(event) => void handleCreateDrone(event)}>
              <div style={{border:'1px solid var(--border)',borderRadius:'8px',padding:'12px',marginBottom:'4px'}}>
                <div style={{fontSize:'0.78rem',fontWeight:700,color:'var(--text-muted)',marginBottom:'8px',letterSpacing:'0.05em'}}>DRONE SUMMARY</div>
                <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'3px 10px',fontSize:'0.83rem'}}>
                  {[
                    ['Name', createBasicData['name']],
                    ['Status', STATUS_META[(createBasicData['status'] as DroneStatus) ?? 'flyable']?.label ?? createBasicData['status'] ?? 'Flyable'],
                    ['Frame', createBasicData['frame']],
                    ['Stack', createBasicData['stack']],
                    ['Motors', createBasicData['motors']],
                    ['Video', createBasicData['video_system']],
                    ['Radio', createBasicData['radio_link']],
                    ['AUW', createBasicData['auw_grams'] ? `${createBasicData['auw_grams']} g` : null],
                    ['Category', createBasicData['category']],
                  ].filter(([, v]) => v).map(([k, v]) => (
                    <Fragment key={String(k)}>
                      <span style={{color:'var(--text-muted)',fontWeight:600}}>{k}:</span>
                      <span>{String(v)}</span>
                    </Fragment>
                  ))}
                </div>
              </div>
              {pendingComponents.length > 0 ? (
                <div style={{border:'1px solid var(--border)',borderRadius:'8px',padding:'12px'}}>
                  <div style={{fontSize:'0.78rem',fontWeight:700,color:'var(--text-muted)',marginBottom:'8px',letterSpacing:'0.05em'}}>HARDWARE BUILD ({pendingComponents.length} parts)</div>
                  {pendingComponents.map(c => (
                    <div key={c._key} style={{fontSize:'0.82rem',marginBottom:'4px',display:'flex',gap:'8px'}}>
                      <span style={{color:'var(--text-muted)',minWidth:120}}>{ROLE_LABELS[c.component_role]}</span>
                      <span style={{fontWeight:600}}>{c.display_name}</span>
                      {c.quantity > 1 && <span style={{color:'var(--text-muted)'}}>×{c.quantity}</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{fontSize:'0.82rem',color:'var(--text-muted)',padding:'6px 0'}}>No hardware parts selected. Drone will be created without a build configuration.</div>
              )}
              <div className="actions">
                <button className="button ghost" type="button" onClick={() => setCreateStep(2)}>← Back to Parts</button>
                <button className="button" type="submit">✓ Create drone</button>
                <button className="button ghost" type="button" style={{marginLeft:'auto'}} onClick={resetWizard}>Cancel</button>
              </div>
            </form>
          )}
        </article>

        <article className="panel span-8">
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'8px'}}>
            <h2 style={{margin:0}}>Drone fleet</h2>
            <input
              type="search"
              placeholder="Search by name…"
              value={fleetSearch}
              onChange={e => setFleetSearch(e.target.value)}
              style={{padding:'4px 10px',fontSize:'0.8rem',background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:'6px',color:'var(--text)',width:'160px'}}
            />
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:'4px',marginBottom:'8px'}}>
            <span style={{fontSize:'0.72rem',color:'var(--text-muted)',alignSelf:'center',marginRight:'2px'}}>Status:</span>
            {(['all', 'flyable', 'needs_repair', 'grounded_crash', 'in_build', 'retired', 'for_parts'] as const).map((f) => (
              <button key={f} className={`button ghost${fleetFilter === f ? ' active' : ''}`} type="button" style={{padding:'3px 8px',fontSize:'0.72rem'}} onClick={() => setFleetFilter(f)}>
                {f === 'all' ? 'All' : (STATUS_META[f as DroneStatus]?.label ?? f)}
              </button>
            ))}
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:'4px',marginBottom:'10px'}}>
            <span style={{fontSize:'0.72rem',color:'var(--text-muted)',alignSelf:'center',marginRight:'2px'}}>Cat:</span>
            {(['all','freestyle','cinewhoop','long-range','racing','other'] as const).map((c) => (
              <button key={c} className={`button ghost${categoryFilter === c ? ' active' : ''}`} type="button" style={{padding:'3px 8px',fontSize:'0.72rem'}} onClick={() => setCategoryFilter(c)}>
                {c === 'all' ? 'All' : c === 'cinewhoop' ? 'Cinewhoop' : c === 'long-range' ? 'Long-range' : c}
              </button>
            ))}
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:'4px',marginBottom:'10px'}}>
            <span style={{fontSize:'0.72rem',color:'var(--text-muted)',alignSelf:'center',marginRight:'2px'}}>Readiness:</span>
            {([
              { value: 'all',         tip: 'Show all drones' },
              { value: 'ready',       tip: 'Flyable with a recent Betaflight snapshot' },
              { value: 'needs_backup',tip: 'Flyable but no Betaflight snapshot saved yet' },
              { value: 'incomplete',  tip: 'Flyable but missing key info (AUW, stack, video, radio)' },
              { value: 'grounded',    tip: 'Not flyable — status is crashed, in build, retired, or for parts' },
            ] as const).map(({ value, tip }) => (
              <button key={value} title={tip} className={`button ghost${readinessFilter === value ? ' active' : ''}`} type="button" style={{padding:'3px 8px',fontSize:'0.72rem'}} onClick={() => setReadinessFilter(value)}>
                {value === 'all' ? 'All' : READINESS_META[value].label}
              </button>
            ))}
          </div>
          <div className="drone-list">
            {drones.filter((d) => {
              if (fleetFilter !== 'all' && d.status !== fleetFilter) return false;
              if (categoryFilter !== 'all') {
                const cat = normalizeCategory(d.category);
                const needle = categoryFilter.toLowerCase();
                if (!cat.includes(needle)) return false;
              }
              if (readinessFilter !== 'all' && getDroneReadiness(d) !== readinessFilter) return false;
              if (fleetSearch.trim()) {
                const q = fleetSearch.trim().toLowerCase();
                if (!d.name.toLowerCase().includes(q) && !(d.frame ?? '').toLowerCase().includes(q)) return false;
              }
              return true;
            }).map((drone) => {
              const sm = STATUS_META[drone.status as DroneStatus] ?? STATUS_META.flyable;
              const readiness = getDroneReadiness(drone);
              const readinessMeta = READINESS_META[readiness];
              return (
              <Fragment key={drone.id}>
              <div
                className={`card card-clickable ${drone.id === selectedDroneId ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSelectedDroneId(drone.id);
                  const preferred = pickDefaultSnapshot(drone);
                  setSelectedSnapshotId(preferred?.id ?? null);
                  if (preferred) {
                    void openRawSnapshot(preferred.id, preferred.name);
                  } else {
                    setRawSnapshot(null);
                    setOk(`Selected ${drone.name}. No snapshots yet.`);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedDroneId(drone.id);
                    const preferred = pickDefaultSnapshot(drone);
                    setSelectedSnapshotId(preferred?.id ?? null);
                    if (preferred) {
                      void openRawSnapshot(preferred.id, preferred.name);
                    } else {
                      setRawSnapshot(null);
                      setOk(`Selected ${drone.name}. No snapshots yet.`);
                    }
                  }
                }}
              >
                <div style={{display:'flex',gap:'12px',alignItems:'flex-start'}}>
                  <div style={{flexShrink:0,width:'72px',height:'54px',borderRadius:'6px',overflow:'hidden',background:'linear-gradient(135deg,var(--surface2) 0%,rgba(255,255,255,0.04) 100%)',display:'flex',alignItems:'center',justifyContent:'center',border:'1px solid var(--border)'}}>
                    {drone.image_url
                      ? <img src={drone.image_url} alt={drone.name} style={{width:'100%',height:'100%',objectFit:'cover'}} onError={(e)=>{(e.target as HTMLImageElement).style.display='none';}}/>
                      : <span style={{fontSize:'1.3rem',opacity:0.3}}>🚁</span>}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div className="meta">
                      <strong>{drone.name}</strong>
                      {drone.category && <span style={{fontSize:'0.72rem',color:'var(--accent)',textTransform:'uppercase',letterSpacing:'0.06em'}}>{drone.category}</span>}
                      <span>{drone.frame || 'Frame not set'}</span>
                    </div>
                    <div className="badge-row" style={{marginTop:'4px'}}>
                      <span className="badge" style={{background:sm.bg,color:sm.color}}>{sm.label}</span>
                      <span className="badge" style={{background:readinessMeta.bg,color:readinessMeta.color}}>{readinessMeta.label}</span>
                      {drone.auw_grams ? <span className="badge">{drone.auw_grams}g</span> : null}
                    </div>
                  </div>
                </div>
                {drone.id === selectedDroneId && (
                  <div style={{marginTop:'14px',paddingTop:'14px',borderTop:'1px solid var(--border)'}} onClick={e=>e.stopPropagation()}>
                    <div style={{display:'flex',gap:'16px',alignItems:'flex-start'}}>
                      <div style={{flexShrink:0,width:'200px'}}>
                        {drone.image_url
                          ? <img src={drone.image_url} alt={drone.name}
                              style={{width:'200px',height:'150px',objectFit:'cover',borderRadius:'8px',border:'1px solid var(--border)',display:'block'}}
                              onError={(e)=>{(e.target as HTMLImageElement).parentElement!.innerHTML='<div style="width:200px;height:150px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:3rem;opacity:0.3">🚁</div>';}}/>
                          : <div style={{width:'200px',height:'150px',borderRadius:'8px',border:'1px solid var(--border)',background:'var(--surface2)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'6px',color:'var(--text-muted)'}}>
                              <span style={{fontSize:'2.5rem',opacity:0.3}}>🚁</span>
                              <span style={{fontSize:'0.72rem'}}>No image</span>
                            </div>}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.82rem'}}>
                          <tbody>
                            {[
                              ['Frame', drone.frame], ['Stack', drone.stack], ['Motors', drone.motors], ['Props', drone.props],
                              ['Video', drone.video_system], ['Radio', drone.radio_link], ['FC target', drone.fc_target],
                              ['AUW', drone.auw_grams ? `${drone.auw_grams} g` : null], ['Category', drone.category],
                            ].filter(([,v]) => v).map(([label, value]) => (
                              <tr key={label as string} style={{borderBottom:'1px solid rgba(255,255,255,0.05)'}}>
                                <td style={{padding:'4px 10px 4px 0',color:'var(--text-muted)',whiteSpace:'nowrap',width:'80px'}}>{label}</td>
                                <td style={{padding:'4px 0',color:'var(--text)',fontWeight:500}}>{value}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {drone.notes && <p style={{margin:'8px 0 0',fontSize:'0.81rem',color:'var(--text-muted)',lineHeight:1.5}}>{drone.notes}</p>}
                        {drone.current_hardware && drone.current_hardware.length > 0 && (
                          <div style={{marginTop:'12px'}}>
                            <div style={{fontSize:'0.75rem',fontWeight:700,color:'var(--text-muted)',marginBottom:'6px',letterSpacing:'0.05em'}}>CURRENT HARDWARE</div>
                            <table style={{width:'100%',fontSize:'0.78rem',borderCollapse:'collapse'}}>
                              <tbody>
                                {drone.current_hardware.map(c => (
                                  <tr key={c.id} style={{borderBottom:'1px solid var(--border)'}}>
                                    <td style={{padding:'3px 6px',color:'var(--text-muted)',whiteSpace:'nowrap'}}>{ROLE_LABELS[c.component_role as ComponentRole] ?? c.component_role}</td>
                                    <td style={{padding:'3px 6px',fontWeight:600}}>
                                      {c.product ? `${c.product.manufacturer?.name ? c.product.manufacturer.name + ' ' : ''}${c.product.name}` : c.custom_name}
                                      {c.product_variant && ` (${c.product_variant.name})`}
                                    </td>
                                    <td style={{padding:'3px 6px',color:'var(--text-muted)'}}>{c.quantity > 1 ? `×${c.quantity}` : ''}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{display:'flex',gap:'6px',flexWrap:'wrap',marginTop:'10px',paddingTop:'8px',borderTop:'1px solid var(--border)'}}>
                      <span className="badge">Snapshots: {drone.snapshots.length}</span>
                      <span className="badge">Flights: {drone.flight_notes.length}</span>
                      <span className="badge">Maintenance: {drone.maintenance_events.length}</span>
                      {getDroneIssues(drone).map(issue => <span key={issue} className="badge warm">{issue}</span>)}
                    </div>
                  </div>
                )}
                <div className="badge-row" style={{justifyContent:'space-between',marginTop:'10px'}}>
                  {drone.id !== selectedDroneId && (
                    <div className="badge-row">
                      <span className="badge">Snapshots: {drone.snapshots.length}</span>
                      <span className="badge">Flights: {drone.flight_notes.length}</span>
                    </div>
                  )}
                  <div className="actions" onClick={(e) => e.stopPropagation()}>
                    <select style={{fontSize:'0.78rem',padding:'3px 6px',background:'var(--bg)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:'4px',cursor:'pointer'}} value={drone.status} onChange={(e) => void handleQuickStatus(drone, e.target.value as DroneStatus)}>
                      {Object.entries(STATUS_META).map(([key, meta]) => (
                        <option key={key} value={key}>{meta.label}</option>
                      ))}
                    </select>
                    <button className="button ghost" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => setEditDroneId(editDroneId === drone.id ? null : drone.id)}>Edit</button>
                    <button className="button ghost" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => handleExportDrone(drone)}>Export JSON</button>
                    {droneToConfirmDelete === drone.id ? (
                      <span style={{display:'inline-flex',gap:'4px',alignItems:'center'}}>
                        <span style={{fontSize:'0.75rem',color:'var(--text-muted)'}}>Delete permanently?</span>
                        <button className="button danger" type="button" style={{padding:'3px 9px',fontSize:'0.78rem'}} onClick={() => void handleDeleteDrone(drone)}>Yes, delete</button>
                        <button className="button ghost" type="button" style={{padding:'3px 9px',fontSize:'0.78rem'}} onClick={() => setDroneToConfirmDelete(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button className="button danger" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => setDroneToConfirmDelete(drone.id)}>Delete</button>
                    )}
                  </div>
                </div>
              </div>
              {editDroneId === drone.id && (
                <div className="edit-panel">
                  <h4 style={{margin:'0 0 10px',fontSize:'0.95rem'}}>Edit &ldquo;{drone.name}&rdquo;</h4>
                  <form className="stack" onSubmit={(event) => void handleUpdateDrone(event, drone.id)}>
                    <div className="two-col">
                      <label className="field">
                        <span>Name</span>
                        <input name="name" defaultValue={drone.name} required />
                      </label>
                      <label className="field">
                        <span>Status</span>
                        <select name="status" defaultValue={drone.status}>
                          <option value="flyable">Flyable</option>
                          <option value="needs_repair">Needs repair</option>
                          <option value="grounded_crash">Crashed / grounded</option>
                          <option value="in_build">In build</option>
                          <option value="retired">Retired</option>
                          <option value="for_parts">For parts</option>
                        </select>
                      </label>
                    </div>
                    <div className="two-col">
                      <label className="field">
                        <span>Frame</span>
                        <input name="frame" defaultValue={drone.frame ?? ''} placeholder="5 inch freestyle" />
                      </label>
                      <label className="field">
                        <span>Stack</span>
                        <input name="stack" defaultValue={drone.stack ?? ''} placeholder="F7 55A" />
                      </label>
                      <label className="field">
                        <span>Motors</span>
                        <input name="motors" defaultValue={drone.motors ?? ''} placeholder="2207 1960KV" />
                      </label>
                      <label className="field">
                        <span>Props</span>
                        <input name="props" defaultValue={drone.props ?? ''} placeholder="5.1x3.6x3" />
                      </label>
                    </div>
                    <div className="two-col">
                      <label className="field">
                        <span>AUW (grams)</span>
                        <input name="auw_grams" type="number" defaultValue={drone.auw_grams ?? ''} placeholder="380" />
                      </label>
                      <label className="field">
                        <span>FC target</span>
                        <input name="fc_target" defaultValue={drone.fc_target ?? ''} placeholder="SPEEDYBEEF405" />
                      </label>
                      <label className="field">
                        <span>Radio link</span>
                        <select key={`radio-${drone.id}`} name="radio_link" defaultValue={drone.radio_link ?? ''}>
                          <option value="">Unknown</option>
                          <option value="ELRS 2.4GHz">ELRS 2.4 GHz</option>
                          <option value="ELRS 900MHz">ELRS 900 MHz</option>
                          <option value="TBS Crossfire">TBS Crossfire</option>
                          <option value="TBS Tracer">TBS Tracer</option>
                          <option value="FrSky D16">FrSky D16</option>
                          <option value="FrSky ACCST">FrSky ACCST</option>
                          <option value="Spektrum">Spektrum</option>
                          <option value="Other">Other</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Video system</span>
                        <select name="video_system" defaultValue={drone.video_system ?? ''}>
                          <option value="">Unknown</option>
                          <option value="Analog">Analog</option>
                          <option value="DJI O3">DJI O3</option>
                          <option value="DJI O4">DJI O4</option>
                          <option value="Avatar HD">Avatar HD</option>
                          <option value="HDZero">HDZero</option>
                        </select>
                      </label>
                    </div>
                    <div className="two-col">
                      <label className="field">
                        <span>Operator ID</span>
                        <input name="operator_id" defaultValue={drone.operator_id ?? ''} placeholder="POL-1234567" />
                      </label>
                      <label className="field">
                        <span>Registration country</span>
                        <input name="registration_country" defaultValue={drone.registration_country ?? ''} placeholder="PL" maxLength={3} />
                      </label>
                      <label className="field">
                        <span>Reg. expiry</span>
                        <input name="registration_expiry" type="date" defaultValue={drone.registration_expiry ?? ''} />
                      </label>
                      <label className="field">
                        <span>Remote ID module</span>
                        <input name="remote_id_module" defaultValue={drone.remote_id_module ?? ''} placeholder="Dronetag Mini" />
                      </label>
                    </div>
                    <div className="two-col">
                      <label className="field">
                        <span>Category</span>
                        <input name="category" defaultValue={drone.category ?? ''} placeholder="freestyle / cinematic / long-range" />
                      </label>
                      <label className="field">
                        <span>Image URL (manufacturer photo)</span>
                        <input name="image_url" type="url" defaultValue={drone.image_url ?? ''} placeholder="https://…" />
                      </label>
                    </div>
                    <label className="field">
                      <span>Notes</span>
                      <textarea name="notes" defaultValue={drone.notes ?? ''} placeholder="Build notes, receiver details, wiring changes..." />
                    </label>
                    <div className="actions">
                      <button className="button" type="submit">Save changes</button>
                      <button className="button ghost" type="button" onClick={() => setEditDroneId(null)}>Cancel</button>
                    </div>
                  </form>
                </div>
              )}
              </Fragment>
              );
            })}
          </div>
        </article>
      </section>
      )}

      {showDroneSections && selectedDrone ? (
        <div className="drone-workspace">
          {/* ── Drone workspace header + tabs ── */}
          <div className="dw-header">
            <div className="dw-title">
              <span style={{fontSize:'1.1rem'}}>📍</span>
              <strong>{selectedDrone.name}</strong>
              <span className="badge" style={{background: STATUS_META[selectedDrone.status].bg, color: STATUS_META[selectedDrone.status].color}}>
                {STATUS_META[selectedDrone.status].label}
              </span>
              {selectedDrone.auw_grams && <span className="badge">{selectedDrone.auw_grams}g</span>}
            </div>
            <div className="dw-tabs">
              {([
                ['snapshots', `Snapshots (${selectedDrone.snapshots.length})`],
                ['flight-log', `Flight Log (${selectedDrone.flight_notes.length})`],
                ['maintenance', `Maintenance (${selectedDrone.maintenance_events.length})`],
                ['checklist', `Checklist (${(checklistItems[selectedDrone.id] ?? []).length})`],
                ['compare', 'Compare'],
              ] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  className={`dw-tab${droneTab === tab ? ' active' : ''}`}
                  type="button"
                  onClick={() => {
                    setDroneTab(tab);
                    if (tab === 'checklist') void loadChecklist(selectedDrone.id);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── SNAPSHOTS TAB ── */}
          {droneTab === 'snapshots' && (
            <section className="content-grid">
              <article className="panel span-4">
                <h3>Create snapshot</h3>
                <form className="stack" onSubmit={(event) => void handleCreateSnapshot(event)}>
                  <label className="field">
                    <span>Snapshot name</span>
                    <input name="name" placeholder="2026-05-08 known-good or similar" required minLength={5} title="At least 5 characters. Use format like YYYY-MM-DD-description for better organization" />
                  </label>
                  <label className="field">
                    <span>Betaflight version</span>
                    <input name="betaflight_version" placeholder="4.5.2" pattern="[0-9]{1,2}\.[0-9]+(\.[0-9]+)?" title="Format: major.minor.patch, e.g. 4.5.2 — use a 1-2 digit major version number" />
                  </label>
                  <label className="field">
                    <span>Notes</span>
                    <textarea name="notes" placeholder="What changed in this snapshot?" />
                  </label>
                  <button className="button secondary" type="submit">Create snapshot</button>
                </form>
              </article>

              <article className="panel span-8">
                <h3>Upload / Import CLI dump</h3>
                <form className="stack" onSubmit={(event) => void handleUpload(event)}
                  onDragOver={e => { e.preventDefault(); (e.currentTarget as HTMLElement).style.outline = '2px dashed var(--accent)'; }}
                  onDragLeave={e => { (e.currentTarget as HTMLElement).style.outline = ''; }}
                  onDrop={e => {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).style.outline = '';
                    const file = e.dataTransfer.files[0];
                    if (!file) return;
                    // Auto-fill file input via DataTransfer
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    const fi = (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input[name="file"]');
                    if (fi) fi.files = dt.files;
                    // Auto-detect export type from filename
                    const sel = (e.currentTarget as HTMLElement).querySelector<HTMLSelectElement>('select[name="exportType"]');
                    if (sel) {
                      const n = file.name.toLowerCase();
                      if (n.includes('diff')) sel.value = 'diff_all';
                      else if (n.includes('dump')) sel.value = 'dump';
                      else if (n.includes('version')) sel.value = 'version';
                      else if (n.includes('status')) sel.value = 'status';
                      else if (n.endsWith('.bbl') || n.endsWith('.bfl')) sel.value = 'blackbox';
                    }
                    // Auto-fill snapshot name from date in filename
                    const nameIn = (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input[name="snapshotName"]');
                    if (nameIn && !nameIn.value) {
                      const today = new Date().toISOString().slice(0,10);
                      nameIn.value = `${today} imported`;
                    }
                  }}
                  style={{borderRadius:'8px',transition:'outline 0.1s'}}
                >
                  <div style={{border:'2px dashed var(--border)',borderRadius:'8px',padding:'16px',textAlign:'center',color:'var(--text-muted)',fontSize:'0.85rem',marginBottom:'4px',cursor:'pointer'}}
                    onClick={() => document.querySelector<HTMLInputElement>('input[name="file"]')?.click()}>
                    <div style={{fontSize:'1.5rem',marginBottom:'4px'}}>📂</div>
                    <div><strong>Drop .txt / .bbl file here</strong> or click to browse</div>
                    <div style={{fontSize:'0.75rem',marginTop:'2px'}}>BF dump, diff all, version, status — type auto-detected from filename</div>
                  </div>
                  <div className="two-col">
                    <label className="field">
                      <span>Target snapshot</span>
                      <select name="snapshotId" defaultValue="">
                        <option value="">— Create new snapshot —</option>
                        {selectedDrone.snapshots.map((snapshot) => (
                          <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>New snapshot name</span>
                      <input name="snapshotName" placeholder={`${new Date().toISOString().slice(0,10)} imported`} />
                    </label>
                  </div>
                  <label className="field">
                    <span>Or paste raw CLI text</span>
                    <textarea name="rawText" rows={3} placeholder="Paste output of: diff all  (BF version auto-detected from header)" />
                  </label>
                  <div className="two-col">
                    <label className="field">
                      <span>Export type</span>
                      <select name="exportType" defaultValue="dump">
                        <option value="dump">dump</option>
                        <option value="diff_all">diff all</option>
                        <option value="status">status</option>
                        <option value="version">version</option>
                        <option value="photo">photo / image</option>
                        <option value="blackbox">blackbox (.bbl/.bfl)</option>
                        <option value="misc">misc</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>File</span>
                      <input name="file" type="file" accept=".txt,.log,.bbl,.bfl,.csv" />
                    </label>
                  </div>
                  <div className="actions">
                    <button className="button" type="submit">Upload & Parse</button>
                  </div>
                </form>
              </article>

              <article className="panel span-5">
                <h3>Snapshot history</h3>
                {selectedDrone.snapshots.length === 0 && (
                  <p style={{color:'var(--text-muted)',fontSize:'0.88rem'}}>No snapshots yet. Create one above.</p>
                )}
                <div className="snapshot-list">
                  {selectedDrone.snapshots.map((snapshot) => (
                    <div key={snapshot.id} className={`card ${snapshot.id === selectedSnapshotId ? 'active' : ''}`}>
                      <div className="meta">
                        <strong>{snapshot.name}</strong>
                        <span>{snapshot.betaflight_version || 'BF version unknown'}</span>
                      </div>
                      <div className="badge-row">
                        {snapshot.is_current ? <span className="badge warm">Current</span> : null}
                        {snapshot.is_known_good ? <span className="badge ok">Known-good</span> : null}
                        <span className="badge">Files: {snapshot.files.length}</span>
                        {(() => {
                          const currentSnap = selectedDrone.snapshots.find((s) => s.is_current);
                          if (currentSnap && currentSnap.id !== snapshot.id && snapshot.betaflight_version && currentSnap.betaflight_version && snapshot.betaflight_version !== currentSnap.betaflight_version) {
                            return <span className="badge danger">BF version mismatch ({snapshot.betaflight_version} vs {currentSnap.betaflight_version})</span>;
                          }
                          return null;
                        })()}
                      </div>
                      <p style={{margin:'4px 0 6px',fontSize:'0.85rem'}}>{snapshot.notes || 'No snapshot notes.'}</p>
                      <small style={{color:'var(--muted)',fontSize:'0.78rem'}}>{formatDate(snapshot.created_at)}</small>
                      <div className="actions" style={{marginTop:'8px'}}>
                        <button className="button ghost" type="button" onClick={() => void openRawSnapshot(snapshot.id, snapshot.name)}>View raw</button>
                        <button className="button ghost" type="button" onClick={() => void markSnapshot(snapshot.id, 'current')}>Mark current</button>
                        <button className="button ghost" type="button" onClick={() => void markSnapshot(snapshot.id, 'known-good')}>Known-good</button>
                        <button className="button ghost" type="button" onClick={() => setEditSnapshotId(editSnapshotId === snapshot.id ? null : snapshot.id)}>Edit</button>
                        <button className="button danger" type="button" style={{padding:'4px 10px',fontSize:'0.78rem',marginLeft:'auto'}} onClick={() => void handleDeleteSnapshot(snapshot)}>Delete</button>
                      </div>
                      {editSnapshotId === snapshot.id && (
                        <form className="stack" style={{marginTop:'8px',padding:'8px',background:'var(--bg)',borderRadius:'6px'}} onSubmit={(e) => void handleUpdateSnapshot(e, snapshot.id, selectedDroneId!)}>
                          <label className="field">
                            <span style={{fontSize:'0.82rem'}}>Name</span>
                            <input name="name" defaultValue={snapshot.name} required minLength={5} style={{fontSize:'0.85rem'}} title="At least 5 characters. Use format like YYYY-MM-DD-description for better organization" />
                          </label>
                          <label className="field">
                            <span style={{fontSize:'0.82rem'}}>BF version</span>
                            <input name="betaflight_version" defaultValue={snapshot.betaflight_version ?? ''} placeholder="4.5.2" pattern="[0-9]{1,2}\.[0-9]+(\.[0-9]+)?" title="Format: major.minor.patch, e.g. 4.5.2 — use a 1-2 digit major version number" style={{fontSize:'0.85rem'}} />
                          </label>
                          <label className="field">
                            <span style={{fontSize:'0.82rem'}}>Notes</span>
                            <textarea name="notes" defaultValue={snapshot.notes ?? ''} style={{fontSize:'0.85rem'}} />
                          </label>
                          <div className="actions">
                            <button className="button" type="submit" style={{fontSize:'0.82rem',padding:'4px 10px'}}>Save</button>
                            <button className="button ghost" type="button" style={{fontSize:'0.82rem',padding:'4px 10px'}} onClick={() => setEditSnapshotId(null)}>Cancel</button>
                          </div>
                        </form>
                      )}
                      <div className="file-list">
                        {snapshot.files.map((file) => (
                          <div key={file.id} className="card">
                            <div className="meta">
                              <strong>{file.original_filename || file.role}</strong>
                              <span>{file.role}</span>
                            </div>
                            <div className="badge-row">
                              <span className="badge">{file.size_bytes} bytes</span>
                              <span className="badge">{file.parse_status}</span>
                            </div>
                            <div className="actions">
                              <a className="button ghost" href={`${apiBase}/api/files/${file.id}/download`} target="_blank">Download</a>
                              <button className="button danger" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => void handleDeleteFile(file)}>Delete</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </article>

              <article className="panel span-7">
                <h3>Raw snapshot viewer</h3>
                {selectedSnapshot ? <p style={{marginBottom:'8px'}}>Active snapshot: <strong>{selectedSnapshot.name}</strong></p> : null}

                {/* ── Structured summary: PID table + rates + filters ── */}
                {rawSnapshot?.summary && (() => {
                  const s = rawSnapshot.summary!;
                  const AXES = ['roll','pitch','yaw'] as const;
                  const axisColor = (a: string) => a === 'roll' ? '#60a0f0' : a === 'pitch' ? '#4fc38a' : '#f0a830';
                  return (
                    <div style={{marginBottom:'12px',display:'flex',flexDirection:'column',gap:'8px'}}>

                      {/* PID Table */}
                      {s.pids && Object.keys(s.pids).filter(k => !k.startsWith('_')).length > 0 && (
                        <div style={{border:'1px solid var(--border)',borderRadius:'8px',overflow:'hidden'}}>
                          <div style={{padding:'6px 10px',background:'var(--surface2)',fontSize:'0.72rem',fontWeight:700,color:'var(--text-muted)',letterSpacing:'0.05em',display:'flex',justifyContent:'space-between'}}>
                            <span>PID TUNING</span>
                            {s.pids._simplified && <span style={{color:'var(--accent)'}}>Simplified mode: ×{s.pids._simplified.master ?? '?'}</span>}
                          </div>
                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.82rem'}}>
                            <thead>
                              <tr style={{background:'rgba(255,255,255,0.03)'}}>
                                <th style={{padding:'4px 8px',textAlign:'left',color:'var(--text-muted)',fontWeight:600,fontSize:'0.72rem'}}></th>
                                {AXES.filter(a => s.pids![a]).map(a => (
                                  <th key={a} style={{padding:'4px 8px',textAlign:'center',color:axisColor(a),fontWeight:700,fontSize:'0.75rem',textTransform:'uppercase'}}>{a}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(['p','i','d','f'] as const).map(term => (
                                <tr key={term} style={{borderTop:'1px solid var(--border)'}}>
                                  <td style={{padding:'4px 8px',color:'var(--text-muted)',fontWeight:700,fontSize:'0.75rem',width:'32px'}}>{term.toUpperCase()}</td>
                                  {AXES.filter(a => s.pids![a]).map(a => (
                                    <td key={a} style={{padding:'4px 8px',textAlign:'center',fontWeight:600,color: s.pids![a]?.[term] != null ? 'var(--text)' : 'var(--text-muted)'}}>
                                      {s.pids![a]?.[term] ?? '—'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Rates Table */}
                      {s.rates?.axes && Object.keys(s.rates.axes).length > 0 && (
                        <div style={{border:'1px solid var(--border)',borderRadius:'8px',overflow:'hidden'}}>
                          <div style={{padding:'6px 10px',background:'var(--surface2)',fontSize:'0.72rem',fontWeight:700,color:'var(--text-muted)',letterSpacing:'0.05em',display:'flex',justifyContent:'space-between'}}>
                            <span>RATES</span>
                            <span style={{color:'var(--accent)',fontWeight:400}}>{s.rates.type}</span>
                          </div>
                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.82rem'}}>
                            <thead>
                              <tr style={{background:'rgba(255,255,255,0.03)'}}>
                                <th style={{padding:'4px 8px',textAlign:'left',color:'var(--text-muted)',fontWeight:600,fontSize:'0.72rem'}}></th>
                                {AXES.filter(a => s.rates!.axes[a]).map(a => (
                                  <th key={a} style={{padding:'4px 8px',textAlign:'center',color:axisColor(a),fontWeight:700,fontSize:'0.75rem',textTransform:'uppercase'}}>{a}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {([['RC Rate','rc_rate'],['Super Rate','super_rate'],['Expo','expo']] as const).map(([label, field]) => (
                                <tr key={field} style={{borderTop:'1px solid var(--border)'}}>
                                  <td style={{padding:'4px 8px',color:'var(--text-muted)',fontSize:'0.75rem',whiteSpace:'nowrap'}}>{label}</td>
                                  {AXES.filter(a => s.rates!.axes[a]).map(a => (
                                    <td key={a} style={{padding:'4px 8px',textAlign:'center',fontWeight:600}}>
                                      {s.rates!.axes[a]?.[field] ?? '—'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                              {s.rates.tpa && (
                                <tr style={{borderTop:'1px solid var(--border)'}}>
                                  <td style={{padding:'4px 8px',color:'var(--text-muted)',fontSize:'0.75rem'}}>TPA</td>
                                  <td colSpan={3} style={{padding:'4px 8px',fontSize:'0.8rem'}}>
                                    {s.rates.tpa.rate}% @ {s.rates.tpa.breakpoint} throttle
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Filters + Motor chips */}
                      {(s.filters || s.motor || s.vtx || s.receiver) && (
                        <div style={{display:'flex',flexWrap:'wrap',gap:'5px'}}>
                          {s.motor?.protocol && <span className="badge" style={{fontSize:'0.73rem'}}>⚙ {s.motor.protocol}</span>}
                          {s.motor?.poles != null && <span className="badge" style={{fontSize:'0.73rem'}}>{s.motor.poles}P motor</span>}
                          {s.motor?.idle_pct != null && <span className="badge" style={{fontSize:'0.73rem'}}>Idle: {s.motor.idle_pct}%</span>}
                          {s.motor?.output_limit_pct != null && s.motor.output_limit_pct !== 100 && <span className="badge" style={{fontSize:'0.73rem',color:'#f0a830'}}>Motor limit: {s.motor.output_limit_pct}%</span>}
                          {s.filters?.mode === 'simplified' && (
                            <span className="badge" style={{fontSize:'0.73rem',background:'rgba(96,160,240,0.12)',color:'#60a0f0'}}>
                              Simplified filters{s.filters.gyro_multiplier != null ? ` ×${s.filters.gyro_multiplier}` : ''}
                            </span>
                          )}
                          {s.filters?.mode === 'manual' && s.filters.gyro_lpf1_hz != null && (
                            <span className="badge" style={{fontSize:'0.73rem'}}>Gyro LPF: {s.filters.gyro_lpf1_hz}Hz</span>
                          )}
                          {s.filters?.dterm_lpf_hz != null && <span className="badge" style={{fontSize:'0.73rem'}}>D-term LPF: {s.filters.dterm_lpf_hz}Hz</span>}
                          {s.filters?.rpm_filter != null && <span className="badge" style={{fontSize:'0.73rem',background:'rgba(79,195,138,0.12)',color:'#4fc38a'}}>RPM filter</span>}
                          {s.filters?.dyn_notch && <span className="badge" style={{fontSize:'0.73rem'}}>Notch ×{s.filters.dyn_notch.count}</span>}
                          {s.vtx?.freq_mhz != null && <span className="badge" style={{fontSize:'0.73rem'}}>📡 {s.vtx.freq_mhz}MHz P{s.vtx.power_level ?? '?'}</span>}
                          {s.vtx?.band != null && <span className="badge" style={{fontSize:'0.73rem'}}>📡 B{s.vtx.band}C{s.vtx.channel} P{s.vtx.power_level ?? '?'}</span>}
                          {s.receiver?.provider && <span className="badge" style={{fontSize:'0.73rem'}}>RX: {s.receiver.provider}</span>}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {rawSnapshot?.files.length ? rawSnapshot.files.map((file) => (
                  <div key={file.file_id} className="stack">
                    <div className="badge-row" style={{justifyContent:'space-between'}}>
                      <div className="badge-row">
                        <span className="badge warm">{file.role}</span>
                        <span className="badge">{file.original_filename || 'inline text'}</span>
                      </div>
                      <button
                        className="button ghost"
                        type="button"
                        style={{padding:'4px 12px',fontSize:'0.82rem',color: lastCopiedFileId === file.file_id ? '#4fc38a' : undefined}}
                        onClick={() => void copyToClipboard(file.content).then(() => {
                          setLastCopiedFileId(file.file_id);
                          setTimeout(() => setLastCopiedFileId(null), 2000);
                        })}
                      >{lastCopiedFileId === file.file_id ? '✓ Copied' : 'Copy'}</button>
                    </div>
                    {file.parsed_config && Object.keys(file.parsed_config).length > 0 && (() => {
                      const parsedSections = Object.entries(file.parsed_config).filter(([, entries]) => Array.isArray(entries));
                      return (
                      <details style={{marginBottom:'6px'}}>
                        <summary style={{cursor:'pointer',fontWeight:600,fontSize:'0.88rem',color:'var(--muted)'}}>
                          Structured config ({parsedSections.reduce((acc, [, entries]) => acc + entries.length, 0)} settings)
                        </summary>
                        {parsedSections.map(([section, entries]) => (
                          <details key={section} style={{marginLeft:'14px',marginTop:'4px'}}>
                            <summary style={{cursor:'pointer',fontSize:'0.85rem',display:'flex',alignItems:'center',gap:'8px'}}>
                              <span style={{textTransform:'capitalize'}}>{section}</span>
                              <span style={{color:'var(--muted)'}}>({entries.length})</span>
                              <button className="button ghost" type="button" style={{padding:'2px 8px',fontSize:'0.75rem',marginLeft:'auto',color: lastCopiedSection === section ? '#4fc38a' : undefined}} onClick={(e) => { e.preventDefault(); copySectionAsCLI(entries, section); }}>{lastCopiedSection === section ? '✓ Copied' : `Copy ${section}`}</button>
                            </summary>
                            <table style={{width:'100%',fontSize:'0.82rem',borderCollapse:'collapse',marginTop:'4px'}}>
                              <tbody>
                                {entries.map(({key, value}) => (
                                  <tr key={key} style={{borderBottom:'1px solid var(--border)'}}>
                                    <td style={{padding:'3px 8px',color:'var(--muted)',fontFamily:'monospace'}}>{key}</td>
                                    <td style={{padding:'3px 8px',fontWeight:600,fontFamily:'monospace'}}>{value}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </details>
                        ))}
                      </details>
                      );
                    })()}
                    <pre className="code-box">{file.content}</pre>
                  </div>
                )) : <p>No raw files attached to the selected snapshot.</p>}
              </article>
            </section>
          )}

          {/* ── FLIGHT LOG TAB ── */}
          {droneTab === 'flight-log' && (
            <section className="content-grid">
              <article className="panel span-4">
                <h3>Add flight note</h3>
                <form className="stack" onSubmit={(event) => void handleCreateNote(event, 'flights')}>
                  <div className="two-col">
                    <label className="field">
                      <span>Title</span>
                      <input name="title" placeholder="Morning freestyle session" required />
                    </label>
                    <label className="field">
                      <span>Date</span>
                      <input name="flight_date" type="date" defaultValue={new Date().toISOString().slice(0,10)} />
                    </label>
                  </div>
                  <label className="field">
                    <span>Outcome</span>
                    <select name="outcome">
                      <option value="ok">✓ OK — successful session</option>
                      <option value="crash">💥 Crash</option>
                      <option value="emergency_landing">⚠ Emergency landing</option>
                      <option value="aborted">↩ Aborted</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Location</span>
                    <input name="location" placeholder="Biała Góra park, Warsaw" />
                  </label>
                  <label className="field">
                    <span>Notes</span>
                    <textarea name="note" placeholder="How did it fly? Observations, issues, improvements..." />
                  </label>
                  <label className="field">
                    <span>Battery used</span>
                    <select name="battery_id">
                      <option value="">— none —</option>
                      {batteries.map(b => (
                        <option key={b.id} value={b.id}>{b.label} ({b.cell_count}S {b.capacity_mah}mAh, {b.cycle_count} cycles)</option>
                      ))}
                    </select>
                  </label>
                  <div className="two-col">
                    <label className="field">
                      <span>Duration (min)</span>
                      <input name="duration_minutes" type="number" min={1} max={600} placeholder="8" />
                    </label>
                    <label className="field">
                      <span>Battery used %</span>
                      <input name="battery_used_percent" type="number" min={1} max={100} placeholder="80" />
                    </label>
                    <label className="field">
                      <span>Voltage after flight (V)</span>
                      <input name="battery_voltage_after" type="number" min={0} max={50} step={0.01} placeholder="15.2" />
                    </label>
                    <label className="field">
                      <span>Wind (km/h)</span>
                      <input name="wind_speed_kmh" type="number" min={0} max={200} placeholder="12" />
                    </label>
                    <label className="field">
                      <span>Temperature (°C)</span>
                      <input name="temperature_c" type="number" min={-30} max={60} placeholder="22" />
                    </label>
                  </div>
                  <div>
                    <span style={{fontSize:'0.8rem',color:'var(--text-muted)',display:'block',marginBottom:'5px'}}>Motor temps after session</span>
                    <div style={{display:'flex',gap:'6px',flexWrap:'wrap'}}>
                      {(['m1','m2','m3','m4'] as const).map(m => (
                        <label key={m} style={{display:'flex',flexDirection:'column',gap:'2px',fontSize:'0.72rem',color:'var(--text-muted)'}}>
                          {m.toUpperCase()}
                          <select name={`motor_temp_${m}`} style={{padding:'3px 6px',fontSize:'0.78rem',background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:'4px',color:'var(--text)'}}>
                            <option value="ok">OK</option>
                            <option value="warm">Warm</option>
                            <option value="hot">Hot</option>
                            <option value="burnt">Burnt</option>
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>
                  <button className="button secondary" type="submit">Add flight note</button>
                </form>
              </article>
              <article className="panel span-8">
                <h3>Flight history — {selectedDrone.name}</h3>
                {selectedDrone.flight_notes.length === 0 && (
                  <p style={{color:'var(--text-muted)',fontSize:'0.88rem'}}>No flight notes yet.</p>
                )}
                <div className="note-list">
                  {selectedDrone.flight_notes.map((note) => (
                    <div key={note.id} className="card">
                      {editingNoteId === note.id && editingNoteTab === 'flights' ? (
                        <form className="stack" style={{gap:'6px'}} onSubmit={(e) => void handleUpdateNote(e, selectedDroneId!, note.id, 'flights')}>
                          <input name="title" defaultValue={note.title} required style={{padding:'4px 8px',fontSize:'0.85rem',background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:'4px',color:'var(--text)'}} />
                          <textarea name="note" defaultValue={note.note} required rows={3} style={{padding:'4px 8px',fontSize:'0.85rem',background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:'4px',color:'var(--text)',resize:'vertical'}} />
                          <div style={{display:'flex',gap:'6px'}}>
                            <button className="button secondary" type="submit" style={{padding:'3px 10px',fontSize:'0.8rem'}}>Save</button>
                            <button className="button ghost" type="button" style={{padding:'3px 10px',fontSize:'0.8rem'}} onClick={() => { setEditingNoteId(null); setEditingNoteTab(null); }}>Cancel</button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                            <strong>{note.title}</strong>
                            <div style={{display:'flex',gap:'4px'}}>
                              <button className="button ghost" type="button" style={{padding:'2px 8px',fontSize:'0.75rem'}} onClick={() => { setEditingNoteId(note.id); setEditingNoteTab('flights'); }}>Edit</button>
                              <button className="button danger" type="button" style={{padding:'2px 8px',fontSize:'0.75rem'}} onClick={() => void handleDeleteNote(selectedDroneId!, note.id, 'flights')}>✕</button>
                            </div>
                          </div>
                          {note.outcome && note.outcome !== 'ok' && (
                            <span className="badge" style={{fontSize:'0.73rem',background: note.outcome === 'crash' ? 'rgba(224,64,64,0.15)' : 'rgba(240,168,48,0.15)',color: note.outcome === 'crash' ? '#e04040' : '#f0a830',marginBottom:'4px',display:'inline-block'}}>
                              {note.outcome === 'crash' ? '💥 Crash' : note.outcome === 'emergency_landing' ? '⚠ Emergency landing' : '↩ Aborted'}
                            </span>
                          )}
                          {note.note && <p>{note.note}</p>}
                          <div style={{display:'flex',gap:'6px',flexWrap:'wrap',marginTop:'4px'}}>
                            {note.location && <span className="badge" style={{fontSize:'0.73rem'}}>📍 {note.location}</span>}
                            {note.battery_id && batteries.find(b => b.id === note.battery_id) && (
                              <span className="badge" style={{background:'rgba(96,160,240,0.15)',color:'#60a0f0',fontSize:'0.73rem'}}>
                                🔋 {batteries.find(b => b.id === note.battery_id)!.label}
                              </span>
                            )}
                            {note.duration_minutes && <span className="badge" style={{fontSize:'0.73rem'}}>⏱ {note.duration_minutes} min</span>}
                            {note.battery_used_percent && <span className="badge" style={{fontSize:'0.73rem'}}>⚡ {note.battery_used_percent}%</span>}
                            {note.battery_voltage_after && <span className="badge" style={{fontSize:'0.73rem'}}>🔋 {note.battery_voltage_after.toFixed(2)}V after</span>}
                            {note.wind_speed_kmh != null && <span className="badge" style={{fontSize:'0.73rem'}}>💨 {note.wind_speed_kmh} km/h</span>}
                            {note.temperature_c != null && <span className="badge" style={{fontSize:'0.73rem'}}>🌡 {note.temperature_c}°C</span>}
                            {note.motor_temps && note.motor_temps !== 'ok,ok,ok,ok' && (
                              <span className="badge" style={{fontSize:'0.73rem',color: note.motor_temps.includes('hot') || note.motor_temps.includes('burnt') ? '#e04040' : '#f0a830'}}>
                                ⚙ Motors: {note.motor_temps.split(',').map((t,i) => t !== 'ok' ? `M${i+1}:${t}` : null).filter(Boolean).join(' ')}
                              </span>
                            )}
                          </div>
                          <small style={{color:'var(--text-muted)'}}>{note.flight_date ?? formatDate(note.created_at)}</small>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </article>
            </section>
          )}

          {/* ── MAINTENANCE TAB ── */}
          {droneTab === 'maintenance' && (
            <section className="content-grid">
              <article className="panel span-4">
                <h3>Add maintenance event</h3>
                <form className="stack" onSubmit={(event) => void handleCreateNote(event, 'maintenance')}>
                  <label className="field">
                    <span>Event type</span>
                    <select name="event_type" value={newMaintEventType} onChange={e => setNewMaintEventType(e.target.value)}>
                      <option value="general">General service</option>
                      <option value="motor_swap">Motor swap</option>
                      <option value="prop_change">Prop change</option>
                      <option value="frame_repair">Frame repair</option>
                      <option value="fc_flash">FC flash / tune</option>
                      <option value="crash">💥 Crash report</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Title</span>
                    <input name="title" placeholder={newMaintEventType === 'crash' ? 'Crash at the park' : 'Replaced front-left motor'} required />
                  </label>
                  <label className="field">
                    <span>Note</span>
                    <textarea name="note" placeholder="What was changed and why?" required />
                  </label>
                  {newMaintEventType === 'crash' && (
                    <>
                      <label className="field">
                        <span>Crash severity</span>
                        <select name="crash_severity">
                          <option value="">Unknown</option>
                          <option value="minor">Minor — cosmetic, no parts replaced</option>
                          <option value="moderate">Moderate — 1-2 parts replaced</option>
                          <option value="severe">Severe — frame + multiple parts</option>
                          <option value="total_loss">Total loss — write-off</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Damaged parts (comma-separated)</span>
                        <input name="damage_items" placeholder="front-left arm, motor 1, prop" />
                      </label>
                      <label className="field">
                        <span>Repair cost (PLN)</span>
                        <input name="repair_cost_pln" type="number" min={0} placeholder="150" />
                      </label>
                    </>
                  )}
                  {spareStock.length > 0 && (
                    <details>
                      <summary style={{cursor:'pointer',fontSize:'0.83rem',color:'var(--text-muted)',marginBottom:'4px'}}>Spare parts used (auto-deducts stock)</summary>
                      <div style={{display:'flex',flexDirection:'column',gap:'4px',marginTop:'6px'}}>
                        {spareStock.filter(s => s.quantity > 0).map(item => (
                          <label key={item.id} style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'0.82rem'}}>
                            <span style={{flex:1}}>{item.part_name} <span style={{color:'var(--text-muted)'}}>({item.quantity} in stock)</span></span>
                            <input name={`spare_qty_${item.id}`} type="number" min={0} max={item.quantity} defaultValue={0}
                              style={{width:'54px',padding:'3px 6px',borderRadius:'4px',border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',fontSize:'0.82rem'}} />
                          </label>
                        ))}
                      </div>
                    </details>
                  )}
                  <button className="button secondary" type="submit" style={newMaintEventType === 'crash' ? {background:'rgba(224,64,64,0.15)',color:'#e04040',border:'1px solid rgba(224,64,64,0.3)'} : {}}>
                    {newMaintEventType === 'crash' ? '💥 Log crash' : 'Add maintenance event'}
                  </button>
                </form>
              </article>
              <article className="panel span-8">
                <h3>Maintenance history — {selectedDrone.name}</h3>
                {selectedDrone.maintenance_events.length === 0 && (
                  <p style={{color:'var(--text-muted)',fontSize:'0.88rem'}}>No maintenance events yet.</p>
                )}
                <div className="note-list">
                  {selectedDrone.maintenance_events.map((note) => {
                    const isCrash = note.event_type === 'crash';
                    const typeLabels: Record<string, string> = {
                      general: 'Service', motor_swap: 'Motor swap', prop_change: 'Prop change',
                      frame_repair: 'Frame repair', fc_flash: 'FC flash', crash: '💥 Crash',
                    };
                    const typeLabel = typeLabels[note.event_type ?? 'general'] ?? note.event_type ?? 'Service';
                    return (
                      <div key={note.id} className="card" style={isCrash ? {borderLeft:'3px solid #e04040'} : {}}>
                        {editingNoteId === note.id && editingNoteTab === 'maintenance' ? (
                          <form className="stack" style={{gap:'6px'}} onSubmit={(e) => void handleUpdateNote(e, selectedDroneId!, note.id, 'maintenance')}>
                            <input name="title" defaultValue={note.title} required style={{padding:'4px 8px',fontSize:'0.85rem',background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:'4px',color:'var(--text)'}} />
                            <textarea name="note" defaultValue={note.note} required rows={3} style={{padding:'4px 8px',fontSize:'0.85rem',background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:'4px',color:'var(--text)',resize:'vertical'}} />
                            <div style={{display:'flex',gap:'6px'}}>
                              <button className="button secondary" type="submit" style={{padding:'3px 10px',fontSize:'0.8rem'}}>Save</button>
                              <button className="button ghost" type="button" style={{padding:'3px 10px',fontSize:'0.8rem'}} onClick={() => { setEditingNoteId(null); setEditingNoteTab(null); }}>Cancel</button>
                            </div>
                          </form>
                        ) : (
                          <>
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                              <div style={{display:'flex',gap:'6px',alignItems:'center',flexWrap:'wrap'}}>
                                <strong>{note.title}</strong>
                                <span className="badge" style={isCrash ? {background:'rgba(224,64,64,0.15)',color:'#e04040',fontSize:'0.73rem'} : {fontSize:'0.73rem'}}>{typeLabel}</span>
                              </div>
                              <div style={{display:'flex',gap:'4px'}}>
                                <button className="button ghost" type="button" style={{padding:'2px 8px',fontSize:'0.75rem'}} onClick={() => { setEditingNoteId(note.id); setEditingNoteTab('maintenance'); }}>Edit</button>
                                <button className="button danger" type="button" style={{padding:'2px 8px',fontSize:'0.75rem'}} onClick={() => void handleDeleteNote(selectedDroneId!, note.id, 'maintenance')}>✕</button>
                              </div>
                            </div>
                            <p>{note.note}</p>
                            {isCrash && (note.damage_items || note.repair_cost_pln) && (
                              <div style={{display:'flex',gap:'8px',flexWrap:'wrap',marginTop:'4px',padding:'6px 8px',background:'rgba(224,64,64,0.06)',borderRadius:'4px'}}>
                                {note.crash_severity && (
                                  <span className="badge" style={{fontSize:'0.73rem',background:'rgba(224,64,64,0.15)',color:'#e04040'}}>
                                    {note.crash_severity.replace('_', ' ')}
                                  </span>
                                )}
                                {note.damage_items && (
                                  <span style={{fontSize:'0.8rem',color:'var(--text-muted)'}}>
                                    <strong>Damaged:</strong> {note.damage_items}
                                  </span>
                                )}
                                {note.repair_cost_pln && (
                                  <span style={{fontSize:'0.8rem',color:'#f0a830'}}>
                                    <strong>Repair cost:</strong> {note.repair_cost_pln} PLN
                                  </span>
                                )}
                              </div>
                            )}
                            <small>{formatDate(note.created_at)}</small>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </article>
            </section>
          )}

          {/* ── CHECKLIST TAB ── */}
          {droneTab === 'checklist' && (() => {
            const items = checklistItems[selectedDrone.id] ?? [];
            const requiredItems = items.filter(i => i.is_required);
            const allChecked = requiredItems.length > 0 && requiredItems.every(i => checklistChecked[`${selectedDrone.id}-${i.id}`]);
            const goNoGo = items.length === 0 ? null : allChecked ? 'go' : 'no-go';

            async function handleAddChecklistItem(e: FormEvent<HTMLFormElement>) {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              try {
                await apiFetch<PreflightItem>(`/api/drones/${selectedDrone!.id}/checklist`, {
                  method: 'POST',
                  body: JSON.stringify({
                    label: fd.get('label'),
                    is_required: fd.get('is_required') === 'on',
                    order_idx: items.length,
                  }),
                });
                await loadChecklist(selectedDrone!.id);
                (e.target as HTMLFormElement).reset();
              } catch (error) { setErr((error as Error).message); }
            }

            async function handleDeleteChecklistItem(itemId: number) {
              if (!confirm('Remove this checklist item?')) return;
              try {
                await apiFetch(`/api/drones/${selectedDrone!.id}/checklist/${itemId}`, { method: 'DELETE' });
                await loadChecklist(selectedDrone!.id);
              } catch (error) { setErr((error as Error).message); }
            }

            return (
              <section className="content-grid">
                <article className="panel span-4">
                  <h3>Add checklist item</h3>
                  <form className="stack" onSubmit={(e) => void handleAddChecklistItem(e)}>
                    <label className="field">
                      <span>Item label</span>
                      <input name="label" placeholder="Props tight? Motors clear?" required />
                    </label>
                    <label style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'0.88rem',cursor:'pointer'}}>
                      <input name="is_required" type="checkbox" defaultChecked />
                      <span>Required (blocks Go status)</span>
                    </label>
                    <button className="button secondary" type="submit">Add item</button>
                  </form>
                  {items.length === 0 && (
                    <div style={{marginTop:'16px'}}>
                      <p style={{color:'var(--text-muted)',fontSize:'0.85rem',marginBottom:'8px'}}>No checklist yet. Some starting ideas:</p>
                      {['Props tight and undamaged', 'Motors spin freely', 'Betaflight backup current', 'Failsafe tested', 'Battery fully charged', 'GPS rescue active (if LR)', 'Remote ID module active'].map(hint => (
                        <button key={hint} className="button ghost" style={{display:'block',width:'100%',textAlign:'left',fontSize:'0.8rem',padding:'4px 8px',marginBottom:'4px'}} type="button"
                          onClick={() => { const el = document.querySelector('input[name=label]') as HTMLInputElement; if(el) { el.value = hint; el.focus(); } }}>
                          + {hint}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
                <article className="panel span-8">
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'12px'}}>
                    <h3 style={{margin:0}}>Pre-flight checklist — {selectedDrone.name}</h3>
                    {goNoGo !== null && (
                      <span className="badge" style={{
                        padding:'4px 12px',fontSize:'0.88rem',fontWeight:700,letterSpacing:'0.05em',
                        background: goNoGo === 'go' ? 'rgba(79,195,138,0.2)' : 'rgba(224,64,64,0.2)',
                        color: goNoGo === 'go' ? '#4fc38a' : '#e04040',
                        border: `1px solid ${goNoGo === 'go' ? 'rgba(79,195,138,0.4)' : 'rgba(224,64,64,0.4)'}`,
                      }}>
                        {goNoGo === 'go' ? '✅ GO' : '🚫 NO-GO'}
                      </span>
                    )}
                  </div>
                  {items.length === 0 && (
                    <p style={{color:'var(--text-muted)',fontSize:'0.88rem'}}>Add checklist items to the left to create a pre-flight routine.</p>
                  )}
                  <div style={{display:'flex',flexDirection:'column',gap:'8px'}}>
                    {items.map(item => {
                      const key = `${selectedDrone.id}-${item.id}`;
                      const checked = !!checklistChecked[key];
                      return (
                        <div key={item.id} style={{display:'flex',alignItems:'center',gap:'10px',padding:'8px 12px',background:'var(--surface2)',borderRadius:'6px',border:`1px solid ${checked ? 'rgba(79,195,138,0.4)' : 'var(--border)'}`}}>
                          <input type="checkbox" checked={checked} onChange={e => setChecklistChecked(prev => ({...prev, [key]: e.target.checked}))}
                            style={{width:'18px',height:'18px',cursor:'pointer',flexShrink:0}} />
                          <span style={{flex:1,fontSize:'0.9rem',textDecoration:checked ? 'line-through' : 'none',color:checked ? 'var(--text-muted)' : 'var(--text)'}}>{item.label}</span>
                          {item.is_required && <span className="badge" style={{fontSize:'0.7rem',background:'rgba(240,168,48,0.12)',color:'#f0a830'}}>required</span>}
                          <button className="button danger" type="button" style={{padding:'2px 6px',fontSize:'0.72rem'}} onClick={() => void handleDeleteChecklistItem(item.id)}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                  {items.length > 0 && (
                    <div style={{marginTop:'12px',display:'flex',gap:'8px'}}>
                      <button className="button ghost" type="button" style={{fontSize:'0.8rem'}}
                        onClick={() => {
                          const newChecked: Record<string, boolean> = {...checklistChecked};
                          items.forEach(i => { newChecked[`${selectedDrone.id}-${i.id}`] = true; });
                          setChecklistChecked(newChecked);
                        }}>Check all</button>
                      <button className="button ghost" type="button" style={{fontSize:'0.8rem'}}
                        onClick={() => {
                          const newChecked: Record<string, boolean> = {...checklistChecked};
                          items.forEach(i => { newChecked[`${selectedDrone.id}-${i.id}`] = false; });
                          setChecklistChecked(newChecked);
                        }}>Reset</button>
                    </div>
                  )}
                </article>
              </section>
            );
          })()}

          {/* ── COMPARE TAB ── */}
          {droneTab === 'compare' && (
            <section className="content-grid">
              <article className="panel span-4">
                <h3>Compare snapshots</h3>
                {selectedDrone.snapshots.length < 2 && (
                  <p style={{color:'var(--text-muted)',fontSize:'0.88rem'}}>Need at least 2 snapshots to compare.</p>
                )}
                <form className="stack" onSubmit={(event) => void handleCompare(event)}>
                  <label className="field">
                    <span>Left snapshot</span>
                    <select name="left_snapshot_id" defaultValue="">
                      <option value="">Select snapshot</option>
                      {selectedDrone.snapshots.map((snapshot) => (
                        <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Right snapshot</span>
                    <select name="right_snapshot_id" defaultValue="">
                      <option value="">Select snapshot</option>
                      {selectedDrone.snapshots.map((snapshot) => (
                        <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>
                      ))}
                    </select>
                  </label>
                  <button className="button" type="submit">Compare</button>
                </form>
              </article>
              <article className="panel span-8">
                <h3>Diff result</h3>
                {compareResult ? (
                  <div className="stack">
                    <div className="badge-row">
                      <span className="badge warm">+{compareResult.added_lines} added</span>
                      <span className="badge">−{compareResult.removed_lines} removed</span>
                    </div>
                    {compareResult.diff ? (() => {
                      // Build a map of changed values: key → {from, to}
                      const changed: Map<string, {from: string; to: string}> = new Map();
                      const lines = compareResult.diff.split('\n');
                      const removed: Map<string, string> = new Map();
                      const added: Map<string, string> = new Map();
                      for (const line of lines) {
                        const m = line.match(/^[-+]\s*set\s+(\S+)\s*=\s*(.+)$/);
                        if (!m) continue;
                        if (line.startsWith('-')) removed.set(m[1], m[2].trim());
                        else if (line.startsWith('+')) added.set(m[1], m[2].trim());
                      }
                      removed.forEach((fromVal, key) => {
                        if (added.has(key)) changed.set(key, { from: fromVal, to: added.get(key)! });
                      });
                      const PID_KEYS = ['p_roll','p_pitch','p_yaw','i_roll','i_pitch','i_yaw','d_roll','d_pitch','d_yaw','f_roll','f_pitch','f_yaw'];
                      const pidChanges = PID_KEYS.filter(k => changed.has(k));
                      return (
                        <>
                          {pidChanges.length > 0 && (
                            <div style={{background:'rgba(96,160,240,0.06)',border:'1px solid rgba(96,160,240,0.2)',borderRadius:'6px',padding:'10px 12px',marginBottom:'8px'}}>
                              <div style={{fontSize:'0.78rem',fontWeight:700,color:'var(--text-muted)',marginBottom:'7px',letterSpacing:'0.05em'}}>PID CHANGES</div>
                              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:'5px'}}>
                                {pidChanges.map(k => {
                                  const {from, to} = changed.get(k)!;
                                  const delta = parseFloat(to) - parseFloat(from);
                                  const color = delta > 0 ? '#4fc38a' : '#e04040';
                                  return (
                                    <div key={k} style={{display:'flex',gap:'5px',alignItems:'center',fontSize:'0.81rem',padding:'3px 6px',borderRadius:'4px',background:'var(--surface2)'}}>
                                      <span style={{fontWeight:600,minWidth:'60px',textTransform:'uppercase',fontSize:'0.73rem',color:'var(--text-muted)'}}>{k.replace('_',' ')}</span>
                                      <span style={{color:'var(--text-muted)'}}>{from}</span>
                                      <span>→</span>
                                      <span style={{fontWeight:700,color}}>{to}</span>
                                      <span style={{fontSize:'0.72rem',color,marginLeft:'2px'}}>({delta > 0 ? '+' : ''}{delta.toFixed(0)})</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                          <pre className="code-box" style={{whiteSpace:'pre-wrap',fontSize:'0.78rem'}}>
                            {lines.map((line, i) => {
                              let cls = '';
                              if (line.startsWith('+')) cls = 'diff-added';
                              else if (line.startsWith('-')) cls = 'diff-removed';
                              else if (line.startsWith('@@')) cls = 'diff-header';
                              return <span key={i} className={cls || undefined}>{line + '\n'}</span>;
                            })}
                          </pre>
                        </>
                      );
                    })() : <p>No textual diff between the snapshots.</p>}
                  </div>
                ) : (
                  <p style={{color:'var(--text-muted)'}}>No comparison run yet. Select two snapshots and click Compare.</p>
                )}
              </article>
            </section>
          )}
        </div>
      ) : null}

      {/* ── Battery fleet (global, not per-drone) ─────────────────────────── */}
      {showBatterySections && (
      <section className="content-grid">
        <article className="panel span-4">
          <h2>Add battery</h2>
          <form className="stack" onSubmit={(event) => void handleCreateBattery(event)}>
            <label className="field">
              <span>Label</span>
              <input name="label" placeholder="Tattu 4S 1550mAh #1" required />
            </label>
            <div className="two-col">
              <label className="field">
                <span>Cells</span>
                <select name="cell_count" defaultValue="4">
                  {[2,3,4,5,6].map((n) => <option key={n} value={n}>{n}S</option>)}
                </select>
              </label>
              <label className="field">
                <span>Capacity (mAh)</span>
                <input name="capacity_mah" type="number" placeholder="1550" min="1" required />
              </label>
            </div>
            <div className="two-col">
              <label className="field">
                <span>Chemistry</span>
                <select name="chemistry" defaultValue="lipo">
                  <option value="lipo">LiPo</option>
                  <option value="lihv">LiHV</option>
                  <option value="li_ion">Li-ion</option>
                </select>
              </label>
              <label className="field">
                <span>Cycles</span>
                <input name="cycle_count" type="number" defaultValue="0" min="0" />
              </label>
            </div>
            <label className="field">
              <span>Purchase date</span>
              <input name="purchase_date" type="date" />
            </label>
            <label className="field">
              <span>Assigned drone (optional)</span>
              <select name="assigned_drone_id">
                <option value="">— not assigned —</option>
                {drones.filter(d => d.status === 'flyable' || d.status === 'in_build').map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
            <details>
              <summary style={{cursor:'pointer',fontSize:'0.83rem',color:'var(--text-muted)',marginBottom:'4px'}}>Internal Resistance per cell (mΩ)</summary>
              <div className="two-col" style={{marginTop:'6px'}}>
                {[1,2,3,4,5,6].map(n => (
                  <label key={n} className="field">
                    <span>C{n}</span>
                    <input name={`ir_c${n}_mohm`} type="number" min={0} max={200} placeholder="e.g. 3" />
                  </label>
                ))}
              </div>
            </details>
            <label className="field">
              <span>Notes</span>
              <textarea name="notes" placeholder="Storage voltage, charger settings, observations..." />
            </label>
            <div className="actions">
              <button className="button" type="submit">Add battery</button>
            </div>
          </form>
        </article>

        <article className="panel span-8">
          <h2>Battery fleet</h2>
          {batteries.length === 0 ? <p style={{color:'var(--text-muted)'}}>No batteries tracked yet. Add your first pack using the form on the left.</p> : (
            <div className="battery-list">
              {batteries.map((bat) => {
                const health = getBatteryHealth(bat);
                const healthColor = health >= 70 ? '#4fc38a' : health >= 40 ? '#f0a830' : '#e04040';
                const statusMeta = BATT_STATUS_META[bat.batt_status ?? 'active'] ?? BATT_STATUS_META.active;
                return (
                <div key={bat.id} className="card">
                  <div className="meta">
                    <strong>{bat.label}</strong>
                    <span>{bat.cell_count}S · {bat.capacity_mah} mAh · {bat.chemistry.replace('_','-').toUpperCase()}</span>
                  </div>
                  <div style={{marginBottom:'6px'}}>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.78rem',marginBottom:'2px'}}>
                      <span style={{color:'var(--text-muted)'}}>Health</span>
                      <span style={{color:healthColor,fontWeight:600}}>{health}%</span>
                    </div>
                    <div style={{height:'6px',borderRadius:'4px',background:'rgba(255,255,255,0.08)',overflow:'hidden'}}>
                      <div style={{height:'100%',width:`${health}%`,background:healthColor,borderRadius:'4px',transition:'width 0.4s'}}/>
                    </div>
                  </div>
                  <div className="badge-row">
                    <span className="badge warm">Cycles: {bat.cycle_count}</span>
                    {bat.purchase_date ? <span className="badge">Bought: {bat.purchase_date}</span> : null}
                    <span className="badge" style={{background:statusMeta.bg,color:statusMeta.color}}>{statusMeta.label}</span>
                    {bat.is_puffed ? <span className="badge" style={{background:'rgba(224,64,64,0.2)',color:'#e04040'}}>Puffed</span> : null}
                    {bat.internal_resistance_mohm ? <span className="badge">IR avg: {bat.internal_resistance_mohm}mΩ</span> : null}
                    {bat.assigned_drone_id && drones.find(d => d.id === bat.assigned_drone_id) && (
                      <span className="badge" style={{background:'rgba(79,195,138,0.12)',color:'#4fc38a',fontSize:'0.73rem'}}>
                        🚁 {drones.find(d => d.id === bat.assigned_drone_id)!.name}
                      </span>
                    )}
                    {bat.last_charged_at && (
                      <span className="badge" style={{fontSize:'0.73rem'}}>
                        Last charged: {new Date(bat.last_charged_at).toLocaleDateString('en-GB',{month:'short',day:'numeric'})}
                      </span>
                    )}
                  </div>
                  {(() => {
                    const cells = [bat.ir_c1_mohm, bat.ir_c2_mohm, bat.ir_c3_mohm, bat.ir_c4_mohm, bat.ir_c5_mohm, bat.ir_c6_mohm]
                      .filter((_, i) => i < bat.cell_count);
                    const hasIR = cells.some(c => c != null);
                    if (!hasIR) return null;
                    const maxIR = Math.max(...cells.filter((c): c is number => c != null));
                    return (
                      <div style={{display:'flex',gap:'4px',flexWrap:'wrap',marginTop:'4px'}}>
                        {cells.map((ir, i) => (
                          <span key={i} style={{
                            fontSize:'0.72rem',padding:'1px 6px',borderRadius:'4px',
                            background: ir == null ? 'var(--surface2)' : ir > 8 ? 'rgba(224,64,64,0.15)' : ir > 5 ? 'rgba(240,168,48,0.15)' : 'rgba(79,195,138,0.12)',
                            color: ir == null ? 'var(--text-muted)' : ir > 8 ? '#e04040' : ir > 5 ? '#f0a830' : '#4fc38a',
                          }}>C{i+1}: {ir != null ? `${ir}mΩ` : '—'}</span>
                        ))}
                        {maxIR > 8 && <span style={{fontSize:'0.72rem',color:'#e04040'}}>⚠ High IR — consider retiring</span>}
                      </div>
                    );
                  })()}
                  {bat.notes ? <p style={{fontSize:'0.84rem',marginTop:'4px'}}>{bat.notes}</p> : null}
                  <div className="actions">
                    <button className="button ghost" type="button" onClick={() => void incrementCycles(bat.id, bat.cycle_count)}>+1 Cycle</button>
                    {!bat.is_puffed && <button className="button ghost" type="button" style={{color:'#f0a830'}} onClick={() => void apiFetch<Battery>(`/api/batteries/${bat.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_puffed:true})}).then(() => apiFetch<Battery[]>('/api/batteries').then(setBatteries))}>Mark puffed</button>}
                    {bat.batt_status !== 'retired' && <button className="button ghost" type="button" style={{color:'#7a8599'}} onClick={() => void apiFetch<Battery>(`/api/batteries/${bat.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({batt_status:'retired'})}).then(() => apiFetch<Battery[]>('/api/batteries').then(setBatteries))}>Retire</button>}
                    <button className="button ghost" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => setQrModal({entityType:'battery',id:bat.id,label:bat.label})}>QR</button>
                    {batteryToConfirmDelete === bat.id ? (
                      <span style={{display:'inline-flex',gap:'4px',alignItems:'center'}}>
                        <span style={{fontSize:'0.75rem',color:'var(--text-muted)'}}>Remove permanently?</span>
                        <button className="button danger" type="button" style={{padding:'3px 9px',fontSize:'0.78rem'}} onClick={() => void deleteBattery(bat.id, bat.label)}>Yes</button>
                        <button className="button ghost" type="button" style={{padding:'3px 9px',fontSize:'0.78rem'}} onClick={() => setBatteryToConfirmDelete(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button className="button ghost" type="button" style={{color:'#b72b0f'}} onClick={() => setBatteryToConfirmDelete(bat.id)}>Remove</button>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </article>
      </section>
      )}

      {/* ── Spare Parts Inventory ─────────────────────────────── */}
      {isBatteriesPage && (
      <section id="spare-parts" style={{padding:'0 20px 32px'}}>
        <div className="panel">
          <h2 style={{marginBottom:'16px'}}>Spare Parts Inventory</h2>
          {spareStock.some(s => s.quantity <= s.low_stock_threshold) && (
            <div style={{marginBottom:'12px',padding:'8px 12px',borderRadius:'6px',background:'rgba(224,64,64,0.1)',border:'1px solid rgba(224,64,64,0.3)',fontSize:'0.85rem'}}>
              <strong style={{color:'#e04040'}}>⚠ Low stock: </strong>
              {spareStock.filter(s => s.quantity <= s.low_stock_threshold).map(s => `${s.part_name} (${s.quantity} left)`).join(', ')}
            </div>
          )}
          {spareStock.length === 0 ? <p>No spare parts tracked yet.</p> : (
            <div style={{display:'flex',flexDirection:'column',gap:'8px',marginBottom:'16px'}}>
              {spareStock.map(item => (
                <div key={item.id} style={{display:'flex',alignItems:'center',gap:'10px',padding:'8px 12px',borderRadius:'6px',background:'var(--card-bg)',border:'1px solid var(--border)'}}>
                  <span style={{flex:1,fontWeight:500}}>{item.part_name}</span>
                  {item.category && <span className="badge" style={{fontSize:'0.72rem'}}>{item.category}</span>}
                  <span style={{color: item.quantity <= item.low_stock_threshold ? '#e04040' : '#4fc38a',fontWeight:600,minWidth:'30px',textAlign:'center'}}>{item.quantity}</span>
                  <button className="button ghost" style={{padding:'2px 8px',fontSize:'0.78rem'}} type="button"
                    onClick={() => void apiFetch<SpareStock>(`/api/spare-stock/${item.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({quantity: item.quantity + 1})})
                      .then(() => apiFetch<SpareStock[]>('/api/spare-stock').then(setSpareStock))}>+1</button>
                  <button className="button ghost" style={{padding:'2px 8px',fontSize:'0.78rem'}} type="button" disabled={item.quantity <= 0}
                    onClick={() => void apiFetch<SpareStock>(`/api/spare-stock/${item.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({quantity: Math.max(0, item.quantity - 1)})})
                      .then(() => apiFetch<SpareStock[]>('/api/spare-stock').then(setSpareStock))}>-1</button>
                  <button className="button danger" style={{padding:'2px 8px',fontSize:'0.78rem'}} type="button"
                    onClick={() => { if (!confirm(`Remove "${item.part_name}" from inventory?`)) return; void apiFetch(`/api/spare-stock/${item.id}`, {method:'DELETE'}).then(() => setSpareStock(prev => prev.filter(s => s.id !== item.id))); }}>✕</button>
                </div>
              ))}
            </div>
          )}
          <form style={{display:'flex',gap:'8px',flexWrap:'wrap',alignItems:'flex-end'}} onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const body = {part_name: String(fd.get('part_name')), category: String(fd.get('category')) || null, quantity: Number(fd.get('quantity')||0), low_stock_threshold: Number(fd.get('threshold')||1), notes: String(fd.get('notes')) || null};
            void apiFetch<SpareStock>('/api/spare-stock', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
              .then(item => { setSpareStock(prev => [...prev, item].sort((a,b) => a.part_name.localeCompare(b.part_name))); (e.target as HTMLFormElement).reset(); });
          }}>
            <input name="part_name" placeholder="Part name" required style={{flex:'2 1 150px',padding:'6px 10px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--input-bg)',color:'var(--text)'}}/>
            <input name="category" placeholder="Category (optional)" style={{flex:'1 1 120px',padding:'6px 10px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--input-bg)',color:'var(--text)'}}/>
            <label style={{display:'flex',flexDirection:'column',gap:'2px',fontSize:'0.72rem',color:'var(--text-muted)'}}>
              Quantity
              <input name="quantity" type="number" min="0" defaultValue="1" style={{width:'70px',padding:'6px 10px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--input-bg)',color:'var(--text)'}}/>
            </label>
            <label style={{display:'flex',flexDirection:'column',gap:'2px',fontSize:'0.72rem',color:'var(--text-muted)'}}>
              Low stock alert at
              <input name="threshold" type="number" min="0" defaultValue="1" style={{width:'90px',padding:'6px 10px',borderRadius:'6px',border:'1px solid var(--border)',background:'var(--input-bg)',color:'var(--text)'}}/>
            </label>
            <button className="button primary" type="submit">Add part</button>
          </form>
        </div>
      </section>
      )}

      {/* ── QR Modal ─────────────────────────────────────────── */}
      {qrModal && (
        <div className="modal-backdrop" onClick={() => setQrModal(null)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}}>
          <div className="panel" onClick={e => e.stopPropagation()} style={{textAlign:'center',padding:'28px 32px',minWidth:'260px'}}>
            <h3 style={{marginBottom:'8px'}}>QR Label</h3>
            <p style={{fontSize:'0.85rem',color:'var(--muted)',marginBottom:'16px'}}>{qrModal.label}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/qr/${qrModal.entityType}/${qrModal.id}?size=220`}
              alt={`QR code for ${qrModal.label}`}
              style={{display:'block',margin:'0 auto 16px',imageRendering:'pixelated'}}
            />
            <div style={{display:'flex',gap:'8px',justifyContent:'center'}}>
              <a className="button ghost" style={{textDecoration:'none'}}
                href={`/api/qr/${qrModal.entityType}/${qrModal.id}?size=400`}
                download={`qr-${qrModal.entityType}-${qrModal.id}.png`}
              >Download PNG</a>
              <button className="button ghost" type="button" onClick={() => setQrModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
