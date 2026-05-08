'use client';

import { FormEvent, Fragment, useCallback, useEffect, useState, useTransition } from 'react';

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
};

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
  operator_id: string | null;
  registration_country: string | null;
  registration_expiry: string | null;
  remote_id_module: string | null;
  created_at: string;
  updated_at: string;
  snapshots: Snapshot[];
  flight_notes: Note[];
  maintenance_events: Note[];
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
  created_at: string;
};

type RawSnapshotResponse = {
  snapshot_id: number;
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
};

const DRONE_TEMPLATES: DroneTemplate[] = [
  { brand:'iFlight', model:'Nazgul Evoque F5 V2', frame:'5"', frame_name:'Nazgul Evoque F5 V2', stack:'BLITZ Mini F7 + E55S 55A', motors:'XING2 2207 1750KV', props:'5.1"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:315, category:'freestyle', notes:'Squashed-X. 4S/6S. Caddx Ratel2 camera.' },
  { brand:'iFlight', model:'Nazgul Evoque F5D V2', frame:'5"', frame_name:'Nazgul Evoque F5D V2', stack:'BLITZ Mini F722 + 55A ESC', motors:'XING2 2207 1750KV 6S', props:'5.1"', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F722', auw_grams:385, category:'freestyle / cinematic', notes:'DeadCat geometry. GPS optional. 4S/6S.' },
  { brand:'iFlight', model:'Nazgul Evoque F5 V3', frame:'5"', frame_name:'Nazgul Evoque F5 V3', stack:'BLITZ Mini F7 + 60A ESC', motors:'XING2 2207 1750KV 6S', props:'5.1"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:420, category:'freestyle', notes:'DC or X geometry. GPS version available. 2025 flagship.' },
  { brand:'iFlight', model:'Nazgul XL5 ECO O4', frame:'5"', frame_name:'Nazgul XL5 ECO', stack:'BLITZ F7 + 55A ESC', motors:'XING 2207 1800KV', props:'5.1"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F722', auw_grams:398, category:'freestyle', notes:'Budget 5-inch with O4-ready layout and serviceable arms.' },
  { brand:'iFlight', model:'Chimera7 Pro V2 O4', frame:'7"', frame_name:'Chimera7 Pro V2', stack:'BLITZ F7 + 55A ESC', motors:'XING2 2809 1250KV', props:'7"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:690, category:'long-range', notes:'Long-range 7-inch platform with GPS and high-efficiency tune profile.' },
  { brand:'iFlight', model:'Chimera5 Pro V2 O4', frame:'5"', frame_name:'Chimera5 Pro V2', stack:'BLITZ F7 + 55A ESC', motors:'XING2 2207 1750KV', props:'5.1"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:458, category:'long-range / freestyle', notes:'Long-range oriented 5-inch with GPS and deadcat visibility.' },
  { brand:'iFlight', model:'Protek35 O4', frame:'3.5"', frame_name:'Protek35', stack:'BLITZ F722 + 45A AIO', motors:'2205.5 2150KV', props:'3.5"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F722', auw_grams:286, category:'cinematic', notes:'3.5-inch ducted cinewhoop for proximity and indoor/outdoor cinematic work.' },
  { brand:'iFlight', model:'Mach R5 Sport', frame:'5"', frame_name:'Mach R5', stack:'BLITZ F7 + 55A ESC', motors:'XING2 2207 2400KV 6S', props:'5.1"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F7_PRO', auw_grams:335, category:'racing', notes:'True-X racing frame. High-KV motors. 6S.' },
  { brand:'iFlight', model:'Defender 20 Lite O4', frame:'2"', frame_name:'Defender 20', stack:'BLITZ F411 AIO + 20A', motors:'1103 14000KV', props:'2"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'IFLIGHT_BLITZ_F411RX', auw_grams:88, category:'cinematic / indoor', notes:'2-inch ducted cinewhoop. 2S.' },
  { brand:'GEPRC', model:'Mark5 Analog', frame:'5"', frame_name:'GEP-MK5 225mm', stack:'GEPRC F7 + 50A BL_32 ESC', motors:'SPEEDX2 2107.5 1960KV', props:'5"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722', auw_grams:365, category:'freestyle', notes:'225mm True-X. HD (O3) and DC O4 Pro variants also available.' },
  { brand:'GEPRC', model:'Mark5 DC O4 Pro', frame:'5"', frame_name:'GEP-MK5 DC 230mm', stack:'TAKER F7 + 50A ESC', motors:'SPEEDX2 2107.5 1960KV', props:'5"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722_BT_HD', auw_grams:395, category:'freestyle / cinematic', notes:'DeadCat GPS. 230mm wheelbase. 2025 release.' },
  { brand:'GEPRC', model:'Mark4 HD O4 Pro', frame:'4"', frame_name:'GEP-MK4', stack:'TAKER F722 + 45A ESC', motors:'SPEEDX2 2004 2850KV', props:'4"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722_BT_HD', auw_grams:258, category:'freestyle / compact', notes:'Compact 4-inch build balancing agility and cleaner footage.' },
  { brand:'GEPRC', model:'CineLog30 V3 O4', frame:'3"', frame_name:'CineLog30 V3', stack:'TAKER F411 + 35A AIO', motors:'1404 3850KV', props:'3"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF405_BT_HD', auw_grams:168, category:'cinematic', notes:'3-inch ducted platform between CL25 and CL35 for mixed indoor/outdoor work.' },
  { brand:'GEPRC', model:'CineLog20 O4', frame:'2"', frame_name:'CineLog20', stack:'TAKER F411 20A AIO', motors:'1202.5 6500KV', props:'2"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF405_BT_HD', auw_grams:112, category:'cinematic / indoor', notes:'Compact 2-inch cinewhoop focused on tight spaces and low-noise flights.' },
  { brand:'GEPRC', model:'SMART 35 HD', frame:'3.5"', frame_name:'SMART 35', stack:'GEPRC F722 + 45A ESC', motors:'2105.5 2650KV', props:'3.5"', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722', auw_grams:232, category:'freestyle / cinematic', notes:'Unducted 3.5-inch with HD payload capacity and robust frame.' },
  { brand:'GEPRC', model:'Cinebot30 HD O3', frame:'3"', frame_name:'Cinebot30 127mm', stack:'GEPRC F7 45A AIO V2', motors:'SPEEDX2 1804 2450KV', props:'3"', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF745_BT_HD', auw_grams:195, category:'cinematic', notes:'127mm cinewhoop. 4S/6S.' },
  { brand:'GEPRC', model:'CineLog35 V3 O4 Pro', frame:'3.5"', frame_name:'GEP-CL35 V3 142mm', stack:'TAKER F7 + 45A AIO', motors:'SPEEDX2 2105.5 2650KV', props:'3.5"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF722_BT_HD', auw_grams:215, category:'cinematic', notes:'142mm ducted. GPS. 6S.' },
  { brand:'GEPRC', model:'Tern LR40', frame:'4"', frame_name:'Tern LR40', stack:'TAKER G4 45A AIO', motors:'SPEEDX2 1404 3000KV', props:'4"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'GEPRCF405_BT_HD', auw_grams:155, category:'long-range', notes:'Sub-250g 4-inch long range. 4S.' },
  { brand:'Flywoo', model:'Explorer LR 4 O4', frame:'4"', frame_name:'Explorer LR 4', stack:'GOKU F405 AIO + 20A ESC', motors:'ROBO 2004 1700KV', props:'4"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:242, category:'long-range', notes:'Sub-250g. 3S. GPS PRO variant also available.' },
  { brand:'Flywoo', model:'Explorer LR 4 PRO O4', frame:'4"', frame_name:'Explorer LR 4 PRO', stack:'GOKU F405 HD + 20A ESC', motors:'ROBO 2004 1700KV', props:'4"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:248, category:'long-range', notes:'Pro variant with stronger camera protection and GPS-first long-range layout.' },
  { brand:'Flywoo', model:'Explorer LR 4 Nano', frame:'4"', frame_name:'Explorer LR 4 Nano', stack:'GOKU F405 Nano + 16A ESC', motors:'1404 2750KV', props:'4"', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:182, category:'long-range / ultralight', notes:'Ultralight analog LR platform for efficient cruising.' },
  { brand:'Flywoo', model:'Firefly 20 PRO O4 Wide', frame:'2"', frame_name:'Firefly 20 PRO', stack:'GOKU F405 AIO + 20A', motors:'1404 3800KV', props:'2"', video_system:'DJI O4 Wide', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:78, category:'cinematic / micro', notes:'2-inch micro O4 wide-angle. 4S.' },
  { brand:'Flywoo', model:'Firefly 25 Nano Baby O4', frame:'2.5"', frame_name:'Firefly 25 Nano Baby', stack:'GOKU F405 20A AIO', motors:'1404 4600KV', props:'2.5"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:118, category:'micro / freestyle', notes:'2.5-inch lightweight build tuned for tight freestyle and quick recovery.' },
  { brand:'Flywoo', model:'Firefly 16 Nano Baby V3 O4', frame:'1.6"', frame_name:'Firefly 16 Nano Baby V3', stack:'GOKU F411 5-in-1 + 12A', motors:'1102 8700KV', props:'1.6"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF411_AIO', auw_grams:38, category:'nano / micro cinematic', notes:'1S nano with upgraded V3 frame and stronger camera cage.' },
  { brand:'Flywoo', model:'FlyLens 75 HD O4', frame:'1.6"', frame_name:'FlyLens 75', stack:'GOKU F411 12A AIO', motors:'1002 22000KV', props:'1.6"', video_system:'DJI O4 Lite', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF411_AIO', auw_grams:46, category:'indoor whoop', notes:'75mm micro whoop for indoor cinematic lines and low acoustic footprint.' },
  { brand:'Flywoo', model:'FlyLens 85 HD O4', frame:'2"', frame_name:'FlyLens 85', stack:'GOKU F405 AIO + 20A', motors:'1202.5 12000KV', props:'2"', video_system:'DJI O4', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF405', auw_grams:52, category:'cinematic / indoor whoop', notes:'85mm ducted whoop. 2S.' },
  { brand:'Flywoo', model:'Vampire 5 HD O3', frame:'5"', frame_name:'Vampire 5', stack:'GOKU F745 AIO + 45A', motors:'ROBO 2207 1750KV', props:'5.1"', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'FLYWOOF745AIO', auw_grams:375, category:'freestyle', notes:'5-inch freestyle. 6S.' },
  { brand:'DeepSpaceFPV', model:'SEEKER5 O4 Pro', frame:'5"', frame_name:'SEEKER5 DC/XL 215mm', stack:'HAKRC F722 V2 + 60A ESC', motors:'Aether 2207.3 1960KV', props:'5.1" Gemfan 51433', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722', auw_grams:382, category:'freestyle', notes:'5-inch DC/XL freestyle with GPS. Also O3 and Analog PNP variants. 6S.' },
  { brand:'DeepSpaceFPV', model:'SEEKER5 O3', frame:'5"', frame_name:'SEEKER5 DC/XL 215mm', stack:'HAKRC F722 V2 + 60A ESC', motors:'Aether 2207.3 1960KV', props:'5.1" Gemfan 51433', video_system:'DJI O3', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722', auw_grams:375, category:'freestyle', notes:'5-inch DC/XL freestyle with GPS. O3 Air Unit variant. 6S.' },
  { brand:'DeepSpaceFPV', model:'SEEKER35 O4 Pro', frame:'3.5"', frame_name:'SEEKER35 DC/XL', stack:'TALOS F722AIO BL32-40A', motors:'Aether 2006 2550KV', props:'3.5" HQ DT90mm', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:228, category:'freestyle', notes:'3.5-inch DC/XL freestyle, GPS, 6S. Also Analog PNP variant.' },
  { brand:'DeepSpaceFPV', model:'SEEKER3 O4 Pro', frame:'3"', frame_name:'SEEKER3 DC/XL', stack:'HAKRC F722 mini V2 + 40A ESC', motors:'Aether 1505 4000KV', props:'3" HQProp T3x3x3', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:165, category:'freestyle', notes:'Sub-250g 3-inch freestyle with GPS. 4S. DC/XL geometry.' },
  { brand:'DeepSpaceFPV', model:'SEEKER3 Analog', frame:'3"', frame_name:'SEEKER3 DC/XL', stack:'HAKRC F722 mini V2 + 40A ESC', motors:'Aether 1505 4000KV', props:'3" HQProp T3x3x3', video_system:'Analog', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:148, category:'freestyle', notes:'Sub-250g 3-inch analog freestyle. GPS. 4S.' },
  { brand:'DeepSpaceFPV', model:'Stellar 25 O4 Pro', frame:'2.5"', frame_name:'Stellar 25', stack:'TALOS F722AIO BL32-40A', motors:'Aether 1404 4600KV', props:'2.5" Gemfan D63', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:122, category:'cinematic / micro', notes:'2.5-inch micro. GPS optional. O4 Pro (bring cam/VTX). 4S.' },
  { brand:'DeepSpaceFPV', model:'ROC7 O4 Pro', frame:'7"', frame_name:'ROC7 322mm', stack:'HAKRC F722 V2 + 60A ESC', motors:'RED LINE 2807 1350KV', props:'7"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722', auw_grams:748, category:'long-range', notes:'7-inch long-range freestyle. T700 carbon fiber. GPS. 6S.' },
  { brand:'DeepSpaceFPV', model:'ROC4 O4 Pro', frame:'4"', frame_name:'ROC4 DC-Type', stack:'TALOS F722AIO BL32-40A', motors:'Aether 1404 3000KV', props:'4"', video_system:'DJI O4 Pro', radio_link:'ELRS 2.4GHz', fc_target:'HAKRCF722MINI', auw_grams:238, category:'long-range', notes:'4-inch DC-type long range with GPS. Sub-250g. 4S.' },
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
  return new Date(value).toLocaleString();
}

const STATUS_META: Record<DroneStatus, {label: string; color: string; bg: string}> = {
  flyable:        { label: 'Flyable',       color: '#4fc38a', bg: 'rgba(79,195,138,0.15)' },
  needs_repair:   { label: 'Needs repair',  color: '#f0a830', bg: 'rgba(240,168,48,0.15)' },
  grounded_crash: { label: 'Crashed',       color: '#e04040', bg: 'rgba(224,64,64,0.15)' },
  in_build:       { label: 'In build',      color: '#60a0f0', bg: 'rgba(96,160,240,0.15)' },
  retired:        { label: 'Retired',       color: '#7a8599', bg: 'rgba(122,133,153,0.15)' },
  for_parts:      { label: 'For parts',     color: '#7a8599', bg: 'rgba(122,133,153,0.12)' },
};

export default function HomePage() {
  const [drones, setDrones] = useState<Drone[]>([]);
  const [batteries, setBatteries] = useState<Battery[]>([]);
  const [selectedDroneId, setSelectedDroneId] = useState<number | null>(null);
  const [editDroneId, setEditDroneId] = useState<number | null>(null);
  const [editSnapshotId, setEditSnapshotId] = useState<number | null>(null);
  const [fleetFilter, setFleetFilter] = useState<DroneStatus | 'all'>('all');
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateBrand, setTemplateBrand] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [rawSnapshot, setRawSnapshot] = useState<RawSnapshotResponse | null>(null);
  const [compareResult, setCompareResult] = useState<CompareResponse | null>(null);
  const [status, setStatus] = useState('Loading drones...');
  const [statusIsError, setStatusIsError] = useState(false);
  const [isPending, startTransition] = useTransition();

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
      ]);
    });
  }, []);

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
    const form = event.currentTarget;
    const formData = new FormData(form);
    const auwRaw = formData.get('auw_grams') as string | null;
    try {
      const drone = await apiFetch<Drone>('/api/drones', {
        method: 'POST',
        body: JSON.stringify({
          name: formData.get('name'),
          frame: formData.get('frame') || null,
          stack: formData.get('stack') || null,
          motors: formData.get('motors') || null,
          props: formData.get('props') || null,
          notes: formData.get('notes') || null,
          status: formData.get('status') || 'flyable',
          auw_grams: auwRaw ? parseInt(auwRaw, 10) : null,
          fc_target: formData.get('fc_target') || null,
          radio_link: formData.get('radio_link') || null,
          video_system: formData.get('video_system') || null,
          operator_id: formData.get('operator_id') || null,
          registration_country: formData.get('registration_country') || null,
          registration_expiry: formData.get('registration_expiry') || null,
          remote_id_module: formData.get('remote_id_module') || null,
        }),
      });
      form.reset();
      const preferredId = selectedDroneId ?? drone.id;
      await loadDrones(preferredId);
      setOk(`Created drone ${drone.name}.`);
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
      setOk('Upload stored in persistent volume.');
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
    try {
      await apiFetch(`/api/batteries/${batteryId}`, { method: 'DELETE' });
      setBatteries((prev) => prev.filter((b) => b.id !== batteryId));
      setOk(`Battery ${label} removed.`);
    } catch (error) {
      setErr((error as Error).message);
    }
  }

  async function handleCreateNote(event: FormEvent<HTMLFormElement>, type: 'flights' | 'maintenance') {
    if (!selectedDrone) {
      setErr('Select a drone first.');
      return;
    }
    const form = event.currentTarget;
    const formData = new FormData(form);
    await submitJson(
      `/api/drones/${selectedDrone.id}/${type}`,
      {
        title: formData.get('title'),
        note: formData.get('note'),
      },
      type === 'flights' ? 'Flight note added.' : 'Maintenance event added.',
      selectedDrone.id,
    );
    form.reset();
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

  function applyTemplate(template: DroneTemplate) {
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
      (document.querySelector<HTMLTextAreaElement>('form textarea[name="notes"]') || {} as HTMLTextAreaElement).value = template.notes || '';
      const radioSelect = document.querySelector<HTMLSelectElement>('form select[name="radio_link"]');
      if (radioSelect && template.radio_link) radioSelect.value = template.radio_link;
      const videoSelect = document.querySelector<HTMLSelectElement>('form select[name="video_system"]');
      if (videoSelect && template.video_system) videoSelect.value = template.video_system;
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setOk('Copied to clipboard.');
    } catch {
      setErr('Clipboard access denied — select and copy manually.');
    }
  }

  function copySectionAsCLI(entries: Array<{key: string; value: string}>) {
    const lines = entries.map(({key, value}) => `set ${key} = ${value}`).join('\n');
    void copyToClipboard(lines);
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
    if (!confirm(`Delete "${drone.name}" and ALL its snapshots and files permanently?`)) return;
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
      setErr('Choose two snapshots to compare.');
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

      <section className="hero-grid">
        <article className="panel span-4">
          <h2>Create drone</h2>
          <form className="stack" onSubmit={(event) => void handleCreateDrone(event)}>
            <label className="field">
              <span>Name</span>
              <input name="name" placeholder="Apex 5" required />
            </label>
            <div className="two-col">
              <label className="field">
                <span>Frame</span>
                <input name="frame" placeholder="5 inch freestyle" />
              </label>
              <label className="field">
                <span>Stack</span>
                <input name="stack" placeholder="F7 55A" />
              </label>
              <label className="field">
                <span>Motors</span>
                <input name="motors" placeholder="2207 1960KV" />
              </label>
              <label className="field">
                <span>Props</span>
                <input name="props" placeholder="5.1x3.6x3" />
              </label>
            </div>
            <div className="two-col">
              <label className="field">
                <span>Status</span>
                <select name="status" defaultValue="flyable">
                  <option value="flyable">Flyable</option>
                  <option value="needs_repair">Needs repair</option>
                  <option value="grounded_crash">Crashed / grounded</option>
                  <option value="in_build">In build</option>
                  <option value="retired">Retired</option>
                  <option value="for_parts">For parts</option>
                </select>
              </label>
              <label className="field">
                <span>AUW (grams)</span>
                <input name="auw_grams" type="number" placeholder="380" min="1" max="25000" />
              </label>
            </div>
            <div className="two-col">
              <label className="field">
                <span>FC target</span>
                <input name="fc_target" placeholder="SPEEDYBEEF405" />
              </label>
              <label className="field">
                <span>Radio link</span>
                <select name="radio_link" defaultValue="">
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
              <select name="video_system" defaultValue="">
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
                <label className="field">
                  <span>Operator ID</span>
                  <input name="operator_id" placeholder="POL-1234567" />
                </label>
                <label className="field">
                  <span>Country</span>
                  <input name="registration_country" placeholder="PL" maxLength={3} />
                </label>
                <label className="field">
                  <span>Registration expiry</span>
                  <input name="registration_expiry" type="date" />
                </label>
                <label className="field">
                  <span>Remote ID module</span>
                  <input name="remote_id_module" placeholder="Dronetag Mini" />
                </label>
              </div>
            </details>
            <label className="field">
              <span>Notes</span>
              <textarea name="notes" placeholder="Build notes, receiver details, wiring changes..." />
            </label>
            <div className="actions">
              <button className="button" type="submit">Create drone</button>
              <button className="button ghost" type="button" onClick={() => setShowTemplates(!showTemplates)}>From template</button>
            </div>
            {showTemplates && (
              <div className="edit-panel" style={{marginTop:'10px'}}>
                {/* Header row */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'10px'}}>
                  <h4 style={{margin:0,fontSize:'0.9rem'}}>Quick-fill from brand template</h4>
                  <button className="button ghost" type="button" style={{fontSize:'0.75rem',padding:'2px 8px'}}
                    onClick={() => { setShowTemplates(false); setTemplateBrand(''); setTemplateSearch(''); }}>✕ Close</button>
                </div>
                {/* Brand tabs */}
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
                {/* Search */}
                <input
                  type="text"
                  placeholder="Search model…"
                  value={templateSearch}
                  onChange={e => setTemplateSearch(e.target.value)}
                  style={{width:'100%',marginBottom:'10px',padding:'5px 9px',borderRadius:'6px',
                    border:'1px solid var(--border)',background:'var(--surface2)',color:'var(--text)',
                    fontSize:'0.82rem',boxSizing:'border-box'}}
                />
                {/* Card grid */}
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
        </article>

        <article className="panel span-8">
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'10px'}}>
            <h2 style={{margin:0}}>Drone fleet</h2>
            <div className="badge-row" style={{gap:'4px'}}>
              {(['all', 'flyable', 'needs_repair', 'grounded_crash', 'in_build', 'retired', 'for_parts'] as const).map((f) => (
                <button key={f} className={`button ghost${fleetFilter === f ? ' active' : ''}`} type="button" style={{padding:'3px 8px',fontSize:'0.75rem'}} onClick={() => setFleetFilter(f)}>
                  {f === 'all' ? 'All' : (STATUS_META[f as DroneStatus]?.label ?? f)}
                </button>
              ))}
            </div>
          </div>
          <div className="drone-list">
            {drones.filter((d) => fleetFilter === 'all' || d.status === fleetFilter).map((drone) => {
              const sm = STATUS_META[drone.status as DroneStatus] ?? STATUS_META.flyable;
              return (
              <Fragment key={drone.id}>
              <button
                className={`card ${drone.id === selectedDroneId ? 'active' : ''}`}
                type="button"
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
              >
                <div className="meta">
                  <strong>{drone.name}</strong>
                  <span>{drone.frame || 'Frame not set'}</span>
                  <span>{drone.stack || 'Stack not set'}</span>
                </div>
                <div className="badge-row" style={{marginBottom:'4px'}}>
                  <span className="badge" style={{background:sm.bg,color:sm.color}}>{sm.label}</span>
                  {drone.auw_grams ? <span className="badge">{drone.auw_grams}g</span> : null}
                  {drone.video_system ? <span className="badge">{drone.video_system}</span> : null}
                  {drone.radio_link ? <span className="badge">{drone.radio_link}</span> : null}
                </div>
                <p style={{margin:'4px 0 8px',fontSize:'0.88rem'}}>{drone.notes || 'No drone notes.'}</p>
                <div className="badge-row" style={{justifyContent:'space-between'}}>
                  <div className="badge-row">
                    <span className="badge">Snapshots: {drone.snapshots.length}</span>
                    <span className="badge">Flights: {drone.flight_notes.length}</span>
                  </div>
                  <div className="actions" onClick={(e) => e.stopPropagation()}>
                    <select style={{fontSize:'0.78rem',padding:'3px 6px',background:'var(--bg)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:'4px',cursor:'pointer'}} value={drone.status} onChange={(e) => void handleQuickStatus(drone, e.target.value as DroneStatus)}>
                      {Object.entries(STATUS_META).map(([key, meta]) => (
                        <option key={key} value={key}>{meta.label}</option>
                      ))}
                    </select>
                    <button className="button ghost" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => setEditDroneId(editDroneId === drone.id ? null : drone.id)}>Edit</button>
                    <button className="button ghost" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => handleExportDrone(drone)}>Export JSON</button>
                    <button className="button danger" type="button" style={{padding:'4px 10px',fontSize:'0.78rem'}} onClick={() => void handleDeleteDrone(drone)}>Delete</button>
                  </div>
                </div>
              </button>
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
                        <select name="radio_link" defaultValue={drone.radio_link ?? ''}>
                          <option value="">Unknown</option>
                          <option value="ELRS 2.4GHz">ELRS 2.4 GHz</option>
                          <option value="ELRS 900MHz">ELRS 900 MHz</option>
                          <option value="TBS Crossfire">TBS Crossfire</option>
                          <option value="TBS Tracer">TBS Tracer</option>
                          <option value="FrSky D16">FrSky D16</option>
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
                    <label className="field">
                      <span>Notes</span>
                      <textarea name="notes" defaultValue={drone.notes ?? ''} />
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

      {selectedDrone ? (
        <section className="content-grid">
          <article className="panel span-4">
            <h3>Create snapshot</h3>
            <form className="stack" onSubmit={(event) => void handleCreateSnapshot(event)}>
              <label className="field">
                <span>Snapshot name</span>
                <input name="name" placeholder="2026-05-08 known-good" required />
              </label>
              <label className="field">
                <span>Betaflight version</span>
                <input name="betaflight_version" placeholder="4.5.2" />
              </label>
              <label className="field">
                <span>Notes</span>
                <textarea name="notes" placeholder="What changed in this snapshot?" />
              </label>
              <button className="button secondary" type="submit">Create snapshot</button>
            </form>
          </article>

          <article className="panel span-8">
            <h3>Upload dump, diff all, or raw CLI</h3>
            <form className="stack" onSubmit={(event) => void handleUpload(event)}>
              <div className="two-col">
                <label className="field">
                  <span>Target snapshot</span>
                  <select name="snapshotId" defaultValue="">
                    <option value="">Create or use without snapshot</option>
                    {selectedDrone.snapshots.map((snapshot) => (
                      <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Or create snapshot on upload</span>
                  <input name="snapshotName" placeholder="2026-05-08 post-repair" />
                </label>
              </div>
              <label className="field">
                <span>Paste raw CLI text (paste-first: just paste and upload)</span>
                <textarea name="rawText" placeholder="Paste dump / diff all output here. No file needed — just paste and click Upload." />
              </label>
              <div className="two-col">
                <label className="field">
                  <span>Export type</span>
                  <select name="exportType" defaultValue="dump">
                    <option value="dump">dump</option>
                    <option value="diff_all">diff_all</option>
                    <option value="status">status</option>
                    <option value="version">version</option>
                    <option value="photo">photo</option>
                    <option value="blackbox">blackbox</option>
                    <option value="misc">misc</option>
                  </select>
                </label>
                <label className="field">
                  <span>Or upload a file</span>
                  <input name="file" type="file" />
                </label>
              </div>
              <div className="actions">
                <button className="button" type="submit">Upload</button>
              </div>
            </form>
          </article>

          <article className="panel span-5">
            <h3>Snapshots</h3>
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
                        <input name="name" defaultValue={snapshot.name} required style={{fontSize:'0.85rem'}} />
                      </label>
                      <label className="field">
                        <span style={{fontSize:'0.82rem'}}>BF version</span>
                        <input name="betaflight_version" defaultValue={snapshot.betaflight_version ?? ''} placeholder="4.5.2" style={{fontSize:'0.85rem'}} />
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
            {selectedSnapshot ? <p>Active snapshot: <strong>{selectedSnapshot.name}</strong></p> : null}
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
                    style={{padding:'4px 12px',fontSize:'0.82rem'}}
                    onClick={() => void copyToClipboard(file.content)}
                  >Copy</button>
                </div>
                {file.parsed_config && Object.keys(file.parsed_config).length > 0 && (
                  <details style={{marginBottom:'6px'}}>
                    <summary style={{cursor:'pointer',fontWeight:600,fontSize:'0.88rem',color:'var(--muted)'}}>
                      Structured config ({Object.values(file.parsed_config).reduce((acc, s) => acc + s.length, 0)} settings)
                    </summary>
                    {Object.entries(file.parsed_config).map(([section, entries]) => (
                      <details key={section} style={{marginLeft:'14px',marginTop:'4px'}}>
                        <summary style={{cursor:'pointer',fontSize:'0.85rem',display:'flex',alignItems:'center',gap:'8px'}}>
                          <span style={{textTransform:'capitalize'}}>{section}</span>
                          <span style={{color:'var(--muted)'}}>({entries.length})</span>
                          <button className="button ghost" type="button" style={{padding:'2px 8px',fontSize:'0.75rem',marginLeft:'auto'}} onClick={(e) => { e.preventDefault(); copySectionAsCLI(entries); }}>Copy {section}</button>
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
                )}
                <pre className="code-box">{file.content}</pre>
              </div>
            )) : <p>No raw files attached to the selected snapshot.</p>}
          </article>

          <article className="panel span-4">
            <h3>Add flight note</h3>
            <form className="stack" onSubmit={(event) => void handleCreateNote(event, 'flights')}>
              <label className="field">
                <span>Title</span>
                <input name="title" placeholder="First tuning pack" required />
              </label>
              <label className="field">
                <span>Note</span>
                <textarea name="note" placeholder="How did it fly?" required />
              </label>
              <button className="button secondary" type="submit">Add flight note</button>
            </form>
            <div className="note-list">
              {selectedDrone.flight_notes.map((note) => (
                <div key={note.id} className="card">
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                    <strong>{note.title}</strong>
                    <button className="button danger" type="button" style={{padding:'2px 8px',fontSize:'0.75rem'}} onClick={() => void handleDeleteNote(selectedDroneId!, note.id, 'flights')}>✕</button>
                  </div>
                  <p>{note.note}</p>
                  <small>{formatDate(note.created_at)}</small>
                </div>
              ))}
            </div>
          </article>

          <article className="panel span-4">
            <h3>Add maintenance event</h3>
            <form className="stack" onSubmit={(event) => void handleCreateNote(event, 'maintenance')}>
              <label className="field">
                <span>Title</span>
                <input name="title" placeholder="Replaced front-left motor" required />
              </label>
              <label className="field">
                <span>Note</span>
                <textarea name="note" placeholder="What was changed and why?" required />
              </label>
              <button className="button secondary" type="submit">Add maintenance event</button>
            </form>
            <div className="note-list">
              {selectedDrone.maintenance_events.map((note) => (
                <div key={note.id} className="card">
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                    <strong>{note.title}</strong>
                    <button className="button danger" type="button" style={{padding:'2px 8px',fontSize:'0.75rem'}} onClick={() => void handleDeleteNote(selectedDroneId!, note.id, 'maintenance')}>✕</button>
                  </div>
                  <p>{note.note}</p>
                  <small>{formatDate(note.created_at)}</small>
                </div>
              ))}
            </div>
          </article>

          <article className="panel span-4">
            <h3>Compare snapshots</h3>
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
            {compareResult ? (
              <div className="stack">
                <div className="badge-row">
                  <span className="badge warm">Added: {compareResult.added_lines}</span>
                  <span className="badge">Removed: {compareResult.removed_lines}</span>
                </div>
                {compareResult.diff ? (
                  <pre className="code-box" style={{whiteSpace:'pre-wrap'}}>
                    {compareResult.diff.split('\n').map((line, i) => {
                      let cls = '';
                      if (line.startsWith('+')) cls = 'diff-added';
                      else if (line.startsWith('-')) cls = 'diff-removed';
                      else if (line.startsWith('@@')) cls = 'diff-header';
                      return <span key={i} className={cls || undefined}>{line + '\n'}</span>;
                    })}
                  </pre>
                ) : <p>No textual diff between the snapshots.</p>}
              </div>
            ) : (
              <p>No comparison run yet.</p>
            )}
          </article>
        </section>
      ) : null}

      {/* ── Battery fleet (global, not per-drone) ─────────────────────────── */}
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
              <span>Notes</span>
              <textarea name="notes" placeholder="Storage voltage, IR notes..." />
            </label>
            <div className="actions">
              <button className="button" type="submit">Add battery</button>
            </div>
          </form>
        </article>

        <article className="panel span-8">
          <h2>Battery fleet</h2>
          {batteries.length === 0 ? <p>No batteries tracked yet.</p> : (
            <div className="battery-list">
              {batteries.map((bat) => (
                <div key={bat.id} className="card">
                  <div className="meta">
                    <strong>{bat.label}</strong>
                    <span>{bat.cell_count}S · {bat.capacity_mah} mAh · {bat.chemistry.replace('_','-').toUpperCase()}</span>
                  </div>
                  <div className="badge-row">
                    <span className="badge warm">Cycles: {bat.cycle_count}</span>
                    {bat.purchase_date ? <span className="badge">Bought: {bat.purchase_date}</span> : null}
                    {bat.cycle_count >= 200 ? <span className="badge" style={{background:'#b72b0f',color:'#fff'}}>Near retirement</span> : null}
                  </div>
                  {bat.notes ? <p style={{fontSize:'0.84rem',marginTop:'4px'}}>{bat.notes}</p> : null}
                  <div className="actions">
                    <button className="button ghost" type="button" onClick={() => void incrementCycles(bat.id, bat.cycle_count)}>+1 Cycle</button>
                    <button className="button ghost" type="button" style={{color:'#b72b0f'}} onClick={() => void deleteBattery(bat.id, bat.label)}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </main>
  );
}
