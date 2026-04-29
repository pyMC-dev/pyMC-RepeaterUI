<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ApiService, { API_SERVER_URL } from '@/utils/api';
import { getToken } from '@/utils/auth';
import type { GPSDiagnostics, GPSSatellite } from '@/types/api';

defineOptions({ name: 'GPSDiagnosticsView' });

type DetailRow = [string, unknown, string?];
type GlobeSatellite = {
  key: string;
  prn: string;
  x: number;
  y: number;
  size: number;
  used: boolean;
  snr: number;
  elevation: number;
  azimuth: number;
  raw: GPSSatellite;
};

type GlobeRenderer = {
  update: (data: GPSDiagnostics | null) => void;
  dispose: () => void;
};

const EARTH_TEXTURE_URL =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_atmos_2048.jpg';

const gps = ref<GPSDiagnostics | null>(null);
const isLoading = ref(true);
const error = ref<string | null>(null);
const lastLoaded = ref<Date | null>(null);
const showRawSnapshot = ref(false);
const eventSource = ref<EventSource | null>(null);
const globeStage = ref<HTMLElement | null>(null);
const globeCanvas = ref<HTMLCanvasElement | null>(null);
const globeWebglFailed = ref(false);
const globeStatus = ref('Waiting for satellite data');
const hoveredGlobeSatellite = ref<GlobeSatellite | null>(null);
const globeTooltipStyle = ref<Record<string, string>>({ left: '0px', top: '0px' });

const status = computed(() => gps.value?.status ?? {});
const fix = computed(() => gps.value?.fix ?? {});
const position = computed(() => gps.value?.position ?? {});
const gpsPosition = computed(() => gps.value?.gps_position ?? gps.value?.position ?? {});
const manualPosition = computed(() => gps.value?.manual_position ?? null);
const positionMeta = computed(() => {
  const meta = gps.value?.position_meta ?? {};
  const gpsFixValid = meta.gps_fix_valid ?? Boolean(status.value.fix_valid);
  return {
    source: meta.source ?? 'gps',
    source_label: meta.source_label ?? (gpsFixValid ? 'GPS fix' : 'GPS estimate'),
    policy: meta.policy ?? 'gps_only',
    manual_config_available: Boolean(meta.manual_config_available),
    gps_fix_valid: gpsFixValid,
  };
});
const motion = computed(() => gps.value?.motion ?? {});
const accuracy = computed(() => gps.value?.accuracy ?? {});
const gpsTime = computed(() => gps.value?.time ?? {});
const satellites = computed(() => gps.value?.satellites ?? {});
const nmea = computed(() => gps.value?.nmea ?? {});
const source = computed(() => gps.value?.source ?? {});

const applyGpsSnapshot = (snapshot: GPSDiagnostics | null) => {
  gps.value = snapshot;
  lastLoaded.value = new Date();
  error.value = null;
  isLoading.value = false;
};

const fetchGps = async () => {
  try {
    if (!gps.value) {
      isLoading.value = true;
    }
    error.value = null;

    const response = await ApiService.getGpsDiagnostics();
    if (response.success === false) {
      throw new Error(response.error || 'GPS API error');
    }

    applyGpsSnapshot(response.data ?? null);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load GPS diagnostics';
  } finally {
    isLoading.value = false;
  }
};

const closeEventSource = () => {
  if (eventSource.value) {
    eventSource.value.close();
    eventSource.value = null;
  }
};

const connectEventSource = () => {
  closeEventSource();

  const token = getToken();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  eventSource.value = new EventSource(`${API_SERVER_URL}/api/gps-stream${tokenParam}`);

  eventSource.value.onmessage = (event: MessageEvent<string>) => {
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!parsed || typeof parsed !== 'object') {
        return;
      }

      const payload = parsed as {
        type?: string;
        data?: GPSDiagnostics | null;
        success?: boolean;
      };

      if (payload.type === 'snapshot') {
        applyGpsSnapshot(payload.data ?? null);
        return;
      }

      if (payload.success === true) {
        applyGpsSnapshot(payload.data ?? null);
      }
    } catch (parseError) {
      console.error('Failed to parse GPS SSE payload:', parseError);
    }
  };

  eventSource.value.onerror = () => {
    if (!gps.value) {
      error.value = 'GPS live stream disconnected. Reconnecting...';
      isLoading.value = false;
    }
  };
};

onMounted(async () => {
  await fetchGps();
  connectEventSource();
});

onUnmounted(() => {
  closeEventSource();
});

const asNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const compactNumber = (value: number): string => {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(6)));
};

const formatValue = (value: unknown, unit = ''): string => {
  if (value === null || value === undefined || value === '') return 'n/a';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'number') return `${compactNumber(value)}${unit ? ` ${unit}` : ''}`;
  return `${String(value)}${unit ? ` ${unit}` : ''}`;
};

const formatCoordinate = (latitude?: number | null, longitude?: number | null): string => {
  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined
  ) {
    return 'n/a';
  }
  return `${compactNumber(latitude)}, ${compactNumber(longitude)}`;
};

const stateLabel = computed(() => (status.value.state ?? 'unknown').replaceAll('_', ' '));

const stateToneClass = computed(() => {
  switch (status.value.state) {
    case 'valid_fix':
      return 'text-accent-green';
    case 'error':
      return 'text-accent-red';
    case 'invalid_fix':
    case 'stale':
    case 'no_data':
    case 'disabled':
      return 'text-secondary';
    default:
      return 'text-content-muted';
  }
});

const summaryCards = computed(() => [
  {
    label: 'Fix State',
    value: stateLabel.value,
    note: status.value.last_error || `quality: ${formatValue(fix.value.quality_label)}`,
    valueClass: stateToneClass.value,
  },
  {
    label: 'Coordinates',
    value: formatCoordinate(position.value.latitude, position.value.longitude),
    note: `${formatValue(positionMeta.value.source_label)} | altitude: ${formatValue(position.value.altitude_m, 'm')}`,
    valueClass: 'text-content-heading dark:text-white',
  },
  {
    label: 'Satellites',
    value: `${formatValue(satellites.value.used_count)} / ${formatValue(satellites.value.in_view_count)}`,
    note: `SNR avg: ${formatValue(satellites.value.snr?.avg, 'dB')}`,
    valueClass: 'text-content-heading dark:text-white',
  },
  {
    label: 'Freshness',
    value:
      status.value.age_seconds === null || status.value.age_seconds === undefined
        ? 'n/a'
        : `${formatValue(status.value.age_seconds)}s`,
    note: status.value.last_update || 'last update unknown',
    valueClass: status.value.stale ? 'text-secondary' : 'text-content-heading dark:text-white',
  },
]);

const detailGroups = computed<Array<{ title: string; rows: DetailRow[] }>>(() => [
  {
    title: 'Receiver Source',
    rows: [
      ['enabled', gps.value?.enabled],
      ['running', gps.value?.running],
      ['source type', source.value.type],
      ['device', source.value.device],
      ['baud rate', source.value.baud_rate],
      ['source path', source.value.source_path],
      ['read timeout', source.value.read_timeout_seconds, 's'],
      ['poll interval', source.value.poll_interval_seconds, 's'],
      ['stale after', source.value.stale_after_seconds, 's'],
    ],
  },
  {
    title: 'Fix',
    rows: [
      ['valid', fix.value.valid],
      ['status', fix.value.status],
      ['quality', fix.value.quality],
      ['quality label', fix.value.quality_label],
      ['GSA fix type', fix.value.gsa_fix_type],
      ['GSA label', fix.value.gsa_fix_type_label],
    ],
  },
  {
    title: 'Position',
    rows: [
      ['display source', positionMeta.value.source_label || positionMeta.value.source],
      ['policy', positionMeta.value.policy],
      ['display latitude', position.value.latitude],
      ['display longitude', position.value.longitude],
      ['GPS latitude', gpsPosition.value.latitude],
      ['GPS longitude', gpsPosition.value.longitude],
      ['manual latitude', manualPosition.value?.latitude],
      ['manual longitude', manualPosition.value?.longitude],
      ['altitude', position.value.altitude_m, 'm'],
      ['geoid separation', position.value.geoid_separation_m, 'm'],
    ],
  },
  {
    title: 'Motion',
    rows: [
      ['speed', motion.value.speed_knots, 'knots'],
      ['speed', motion.value.speed_kmh, 'km/h'],
      ['course', motion.value.course_degrees, 'deg'],
      ['magnetic variation', motion.value.magnetic_variation_degrees, 'deg'],
    ],
  },
  {
    title: 'Accuracy',
    rows: [
      ['HDOP', accuracy.value.hdop],
      ['PDOP', accuracy.value.pdop],
      ['VDOP', accuracy.value.vdop],
    ],
  },
  {
    title: 'Time',
    rows: [
      ['UTC time', gpsTime.value.utc_time],
      ['date', gpsTime.value.date],
      ['datetime UTC', gpsTime.value.datetime_utc],
    ],
  },
  {
    title: 'NMEA Health',
    rows: [
      ['last talker', nmea.value.last_talker],
      ['last sentence type', nmea.value.last_sentence_type],
      ['seen sentence types', nmea.value.seen_sentence_types],
      ['valid checksums', nmea.value.valid_checksum_count],
      ['invalid checksums', nmea.value.invalid_checksum_count],
      ['missing checksums', nmea.value.missing_checksum_count],
      ['last sentence', nmea.value.last_sentence],
    ],
  },
]);

const visibleSatellites = computed(() => satellites.value.in_view ?? []);
const recentSentences = computed(() => nmea.value.recent_sentences ?? []);

const skySatellites = computed<GlobeSatellite[]>(() => {
  const usedPrns = new Set((satellites.value.used_prns ?? []).map(String));
  return visibleSatellites.value
    .map((satellite: GPSSatellite) => {
      const azimuth = asNumber(satellite.azimuth_degrees);
      const elevation = asNumber(satellite.elevation_degrees);
      if (azimuth === null || elevation === null) return null;

      const snr = Math.max(0, Math.min(60, asNumber(satellite.snr_db) ?? 0));
      const radius = (1 - Math.max(0, Math.min(90, elevation)) / 90) * 82;
      const azimuthRadians = (azimuth * Math.PI) / 180;
      const prn = satellite.prn ?? '?';

      return {
        key: `${prn}-${azimuth}-${elevation}`,
        prn: String(prn),
        x: 100 + Math.sin(azimuthRadians) * radius,
        y: 100 - Math.cos(azimuthRadians) * radius,
        size: 4 + (snr / 60) * 7,
        used: usedPrns.has(String(prn)),
        snr,
        elevation,
        azimuth,
        raw: satellite,
      };
    })
    .filter((satellite): satellite is NonNullable<typeof satellite> => satellite !== null);
});

const globeCountLabel = computed(
  () => `${skySatellites.value.length} sat${skySatellites.value.length === 1 ? '' : 's'}`,
);

const fallbackSatelliteStyle = (satellite: GlobeSatellite) =>
  ({
    left: `${satellite.x / 2}%`,
    top: `${satellite.y / 2}%`,
    '--size': `${satellite.size + 5}px`,
  }) as Record<string, string>;

let globeRenderer: GlobeRenderer | null = null;

const cssVar = (name: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  return (
    window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  );
};

const updateFallbackGlobe = (data: GPSDiagnostics | null) => {
  const count = skySatellites.value.length;
  if (!data) {
    globeStatus.value = 'Waiting for satellite data';
    return;
  }
  globeStatus.value = count
    ? `2D fallback: ${count} satellites plotted from GSV az/el`
    : 'Waiting for satellites in view';
};

const createSatelliteGlobe = (): GlobeRenderer => {
  const canvas = globeCanvas.value;
  const stage = globeStage.value;
  if (!canvas || !stage) {
    throw new Error('Satellite globe container is not mounted');
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  });
  const controls = new OrbitControls(camera, renderer.domElement);
  const root = new THREE.Group();
  const satelliteGroup = new THREE.Group();
  const linkGroup = new THREE.Group();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hoverScale = new THREE.Vector3();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let satelliteMeshes: THREE.Mesh[] = [];
  let hoveredMesh: THREE.Mesh | null = null;
  let lastPointer: PointerEvent | null = null;
  let animationId = 0;

  camera.position.set(0, 0.1, 3.72);
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 2.45;
  controls.maxDistance = 5.6;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.72;
  controls.target.set(0, 0, 0);
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.84));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.78);
  keyLight.position.set(2.7, 2.2, 3.4);
  scene.add(keyLight);

  const earthMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(cssVar('--color-primary', '#0d7377')),
    roughness: 0.62,
    metalness: 0.04,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 56, 36), earthMaterial);
  new THREE.TextureLoader().load(
    EARTH_TEXTURE_URL,
    (texture) => {
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      earthMaterial.map = texture;
      earthMaterial.color.set(0xffffff);
      earthMaterial.roughness = 0.82;
      earthMaterial.needsUpdate = true;
    },
    undefined,
    () => {
      globeStatus.value = 'Earth texture unavailable; using local fallback globe';
    },
  );

  const grid = new THREE.Mesh(
    new THREE.SphereGeometry(1.006, 28, 18),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(cssVar('--color-primary', '#aae8e8')),
      wireframe: true,
      transparent: true,
      opacity: 0.16,
    }),
  );
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.045, 48, 24),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(cssVar('--color-primary', '#aae8e8')),
      transparent: true,
      opacity: 0.1,
      side: THREE.BackSide,
    }),
  );

  root.add(earth, grid, atmosphere, linkGroup, satelliteGroup);
  scene.add(root);

  const resize = () => {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(240, Math.floor(rect.width));
    const height = Math.max(240, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const disposeObject = (object: THREE.Object3D) => {
    const disposable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    disposable.geometry?.dispose();
    const materials = Array.isArray(disposable.material)
      ? disposable.material
      : [disposable.material];
    materials.forEach((material) => {
      if (!material) return;
      const mappedMaterial = material as THREE.Material & { map?: THREE.Texture };
      mappedMaterial.map?.dispose();
      material.dispose();
    });
  };

  const clearGroup = (group: THREE.Group) => {
    while (group.children.length) {
      const child = group.children.pop();
      if (!child) continue;
      child.traverse(disposeObject);
      group.remove(child);
    }
  };

  const latLonVector = (latitude: number, longitude: number, radius = 1) => {
    const lat = (latitude * Math.PI) / 180;
    const lon = (longitude * Math.PI) / 180;
    return new THREE.Vector3(
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
      Math.cos(lat) * Math.cos(lon),
    ).multiplyScalar(radius);
  };

  const localBasis = (latitude: number, longitude: number) => {
    const lon = (longitude * Math.PI) / 180;
    const up = latLonVector(latitude, longitude, 1).normalize();
    const east = new THREE.Vector3(Math.cos(lon), 0, -Math.sin(lon)).normalize();
    const north = up.clone().cross(east).normalize();
    return { east, north, up };
  };

  const addLine = (points: THREE.Vector3[], color: string, opacity = 0.34) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity,
    });
    linkGroup.add(new THREE.Line(geometry, material));
  };

  const roundedRect = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ) => {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
  };

  const addLabel = (text: string, labelPosition: THREE.Vector3, color: string, scale = 1) => {
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 192;
    labelCanvas.height = 76;
    const context = labelCanvas.getContext('2d');
    if (!context) return;
    context.font = '800 28px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    roundedRect(context, 20, 14, 152, 48, 16);
    context.fillStyle = 'rgba(3, 8, 10, 0.88)';
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = color;
    context.stroke();
    context.fillStyle = '#ffffff';
    context.shadowColor = 'rgba(0, 0, 0, 0.92)';
    context.shadowBlur = 7;
    context.fillText(text, 96, 39);
    const texture = new THREE.CanvasTexture(labelCanvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.98,
        depthTest: false,
        depthWrite: false,
      }),
    );
    sprite.position.copy(labelPosition);
    sprite.scale.set(0.3 * scale, 0.12 * scale, 1);
    sprite.renderOrder = 10;
    satelliteGroup.add(sprite);
  };

  const hideTooltip = (clearPointer = false) => {
    hoveredMesh = null;
    hoveredGlobeSatellite.value = null;
    if (clearPointer) {
      lastPointer = null;
    }
  };

  const showTooltip = (mesh: THREE.Mesh, event: PointerEvent) => {
    const satellite = mesh.userData.satellite as GlobeSatellite | undefined;
    if (!satellite) return;
    const rect = stage.getBoundingClientRect();
    globeTooltipStyle.value = {
      left: `${Math.max(86, Math.min(rect.width - 86, event.clientX - rect.left))}px`,
      top: `${Math.max(84, Math.min(rect.height - 12, event.clientY - rect.top))}px`,
    };
    hoveredGlobeSatellite.value = satellite;
  };

  const handlePointerMove = (event: PointerEvent) => {
    lastPointer = event;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(satelliteMeshes, false)[0];
    hoveredMesh = hit ? (hit.object as THREE.Mesh) : null;
    if (hoveredMesh) {
      showTooltip(hoveredMesh, event);
    } else {
      hideTooltip();
    }
  };

  const addSatellite = (
    satellite: GlobeSatellite,
    basis: ReturnType<typeof localBasis>,
    userPosition: THREE.Vector3,
  ) => {
    const az = (satellite.azimuth * Math.PI) / 180;
    const el = (Math.max(0, Math.min(90, satellite.elevation)) * Math.PI) / 180;
    const horizon = basis.north
      .clone()
      .multiplyScalar(Math.cos(az))
      .add(basis.east.clone().multiplyScalar(Math.sin(az)));
    const direction = horizon
      .multiplyScalar(Math.cos(el))
      .add(basis.up.clone().multiplyScalar(Math.sin(el)))
      .normalize();
    const satPosition = userPosition.clone().add(direction.multiplyScalar(0.62));
    const color = satellite.used
      ? cssVar('--color-accent-green', '#a5e5b6')
      : cssVar('--color-primary', '#aae8e8');
    const radius = 0.024 + (satellite.snr / 60) * 0.042;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }),
    );
    marker.position.copy(satPosition);
    marker.userData = { satellite, used: satellite.used };
    satelliteMeshes.push(marker);
    satelliteGroup.add(marker);
    addLine(
      [userPosition.clone().multiplyScalar(1.012), satPosition],
      color,
      satellite.used ? 0.46 : 0.26,
    );
    addLabel(satellite.prn, satPosition.clone().multiplyScalar(1.035), color, 0.88);
  };

  const addReceiver = (latitude: number, longitude: number) => {
    const userPosition = latLonVector(latitude, longitude, 1.022);
    const basis = localBasis(latitude, longitude);
    const receiverColor = cssVar('--color-accent-green', '#a5e5b6');
    const receiver = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 18, 14),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(receiverColor) }),
    );
    receiver.position.copy(userPosition);
    satelliteGroup.add(receiver);
    addLabel('YOU', userPosition.clone().multiplyScalar(1.08), receiverColor, 1);

    const ringPoints: THREE.Vector3[] = [];
    for (let index = 0; index <= 96; index += 1) {
      const angle = (index / 96) * Math.PI * 2;
      ringPoints.push(
        userPosition
          .clone()
          .add(basis.north.clone().multiplyScalar(Math.cos(angle) * 0.62))
          .add(basis.east.clone().multiplyScalar(Math.sin(angle) * 0.62)),
      );
    }
    addLine(ringPoints, receiverColor, 0.28);
    return { basis, userPosition };
  };

  const update = (data: GPSDiagnostics | null) => {
    const latitude = asNumber(data?.position?.latitude);
    const longitude = asNumber(data?.position?.longitude);
    const pointerToRestore = lastPointer;
    satelliteMeshes = [];
    hoveredMesh = null;
    clearGroup(satelliteGroup);
    clearGroup(linkGroup);

    if (latitude === null || longitude === null) {
      globeStatus.value = 'Waiting for receiver position';
      hideTooltip();
      return;
    }

    const userDirection = latLonVector(latitude, longitude, 1).normalize();
    const targetDirection = new THREE.Vector3(0.1, 0.1, 1).normalize();
    root.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(userDirection, targetDirection));

    const { basis, userPosition } = addReceiver(latitude, longitude);
    skySatellites.value.forEach((satellite) => addSatellite(satellite, basis, userPosition));
    globeStatus.value = skySatellites.value.length
      ? `${skySatellites.value.length} satellites plotted from GSV az/el using ${formatValue(positionMeta.value.source_label || 'receiver position')}`
      : 'No satellites in view yet';

    if (pointerToRestore) {
      window.requestAnimationFrame(() => handlePointerMove(pointerToRestore));
    } else {
      hideTooltip();
    }
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();
  const handlePointerLeave = () => hideTooltip(true);
  const preventWheelScroll = (event: WheelEvent) => event.preventDefault();
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerleave', handlePointerLeave);
  canvas.addEventListener('wheel', preventWheelScroll, { passive: false });

  const animate = () => {
    if (!reducedMotion) {
      atmosphere.rotation.y += 0.0012;
      grid.rotation.y += 0.0005;
    }
    controls.update();
    satelliteMeshes.forEach((mesh) => {
      const target = mesh === hoveredMesh ? 1.75 : 1;
      hoverScale.set(target, target, target);
      mesh.scale.lerp(hoverScale, 0.18);
    });
    renderer.render(scene, camera);
    animationId = window.requestAnimationFrame(animate);
  };
  animate();

  return {
    update,
    dispose() {
      window.cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('wheel', preventWheelScroll);
      controls.dispose();
      clearGroup(satelliteGroup);
      clearGroup(linkGroup);
      root.traverse(disposeObject);
      renderer.dispose();
    },
  };
};

const refreshGlobe = async (data: GPSDiagnostics | null = gps.value) => {
  await nextTick();
  if (globeWebglFailed.value) {
    updateFallbackGlobe(data);
    return;
  }
  try {
    if (!globeRenderer) {
      globeRenderer = createSatelliteGlobe();
    }
    globeRenderer.update(data);
  } catch (err) {
    console.warn('Satellite globe failed; using fallback', err);
    globeWebglFailed.value = true;
    updateFallbackGlobe(data);
  }
};

onMounted(() => {
  void refreshGlobe();
});

watch(
  gps,
  (data) => {
    void refreshGlobe(data);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  globeRenderer?.dispose();
  globeRenderer = null;
});

const rawSnapshot = computed(() => JSON.stringify(gps.value ?? {}, null, 2));
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-content-heading dark:text-white">GPS Diagnostics</h1>
        <p class="text-sm text-content-muted">
          Live NMEA receiver state, parsed fix data, and satellite visibility.
        </p>
      </div>

      <button
        type="button"
        class="rounded-[10px] border border-stroke-subtle dark:border-white/10 bg-white/80 dark:bg-white/10 px-4 py-2 text-sm font-semibold text-content-primary dark:text-white transition-colors hover:bg-white dark:hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="isLoading"
        @click="fetchGps"
      >
        {{ isLoading ? 'Refreshing' : 'Refresh' }}
      </button>
    </div>

    <div
      v-if="error"
      class="rounded-[10px] border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red"
    >
      {{ error }}
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <section v-for="card in summaryCards" :key="card.label" class="glass-card min-h-[118px] p-4">
        <p class="text-xs uppercase text-content-muted">{{ card.label }}</p>
        <p :class="['mt-2 break-words text-xl font-semibold leading-tight', card.valueClass]">
          {{ card.value }}
        </p>
        <p class="mt-2 break-words text-xs text-content-muted">{{ card.note }}</p>
      </section>
    </div>

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
      <section class="glass-card p-5">
        <div class="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-content-heading dark:text-white">
              Satellite Globe
            </h2>
            <p class="text-xs text-content-muted">
              {{ skySatellites.length }} satellite{{ skySatellites.length === 1 ? '' : 's' }}
              plotted from GSV azimuth, elevation, and SNR.
            </p>
          </div>
          <span
            class="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary"
          >
            {{ globeCountLabel }}
          </span>
        </div>

        <div ref="globeStage" class="globe-stage">
          <canvas
            v-show="!globeWebglFailed"
            ref="globeCanvas"
            aria-label="3D globe showing satellites around the current receiver position"
          ></canvas>

          <div v-if="globeWebglFailed" class="globe-fallback">
            <div
              v-if="skySatellites.length"
              class="fallback-sky"
              aria-label="Fallback satellite sky plot"
            >
              <div
                v-for="satellite in skySatellites"
                :key="satellite.key"
                class="fallback-sat"
                :class="{ 'fallback-sat-used': satellite.used }"
                :style="fallbackSatelliteStyle(satellite)"
              >
                <span>{{ satellite.prn }}</span>
              </div>
            </div>
            <div v-else class="sky-empty">No satellites in view yet</div>
          </div>

          <div
            v-if="hoveredGlobeSatellite"
            class="globe-tooltip"
            :style="globeTooltipStyle"
            role="status"
            aria-live="polite"
          >
            <div class="tooltip-title">SAT {{ hoveredGlobeSatellite.prn }}</div>
            <div class="tooltip-grid">
              <span class="tooltip-key">SNR</span>
              <span class="tooltip-value">{{ formatValue(hoveredGlobeSatellite.snr, 'dB') }}</span>
              <span class="tooltip-key">Elevation</span>
              <span class="tooltip-value">{{
                formatValue(hoveredGlobeSatellite.elevation, 'deg')
              }}</span>
              <span class="tooltip-key">Azimuth</span>
              <span class="tooltip-value">{{
                formatValue(hoveredGlobeSatellite.azimuth, 'deg')
              }}</span>
              <span class="tooltip-key">Used in fix</span>
              <span class="tooltip-value">{{ formatValue(hoveredGlobeSatellite.used) }}</span>
            </div>
          </div>
        </div>

        <div
          class="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-content-muted"
        >
          <span>{{ globeStatus }}</span>
          <span>Drag to rotate. Scroll to zoom. Hover a satellite for details.</span>
        </div>

        <div class="mt-4 flex flex-wrap gap-3 text-xs text-content-muted">
          <span class="inline-flex items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full bg-accent-green"></span>
            Used in fix
          </span>
          <span class="inline-flex items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full bg-primary"></span>
            In view
          </span>
          <span>Last UI refresh: {{ lastLoaded ? lastLoaded.toLocaleTimeString() : 'n/a' }}</span>
        </div>
      </section>

      <section class="glass-card p-5">
        <h2 class="mb-4 text-lg font-semibold text-content-heading dark:text-white">Position</h2>
        <div class="space-y-3 text-sm">
          <div class="grid grid-cols-[150px_minmax(0,1fr)] gap-3">
            <span class="text-content-muted">Display source</span>
            <span class="break-words text-content-primary dark:text-white">
              {{ formatValue(positionMeta.source_label || positionMeta.source) }}
            </span>
          </div>
          <div class="grid grid-cols-[150px_minmax(0,1fr)] gap-3">
            <span class="text-content-muted">Display location</span>
            <span class="break-words text-content-primary dark:text-white">
              {{ formatCoordinate(position.latitude, position.longitude) }}
            </span>
          </div>
          <div class="grid grid-cols-[150px_minmax(0,1fr)] gap-3">
            <span class="text-content-muted">GPS location</span>
            <span class="break-words text-content-primary dark:text-white">
              {{ formatCoordinate(gpsPosition.latitude, gpsPosition.longitude) }}
            </span>
          </div>
          <div class="grid grid-cols-[150px_minmax(0,1fr)] gap-3">
            <span class="text-content-muted">Manual location</span>
            <span class="break-words text-content-primary dark:text-white">
              {{
                manualPosition
                  ? formatCoordinate(manualPosition.latitude, manualPosition.longitude)
                  : 'n/a'
              }}
            </span>
          </div>
          <div class="grid grid-cols-[150px_minmax(0,1fr)] gap-3">
            <span class="text-content-muted">Policy</span>
            <span class="break-words text-content-primary dark:text-white">
              {{ formatValue(positionMeta.policy) }}
            </span>
          </div>
        </div>
      </section>
    </div>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <section v-for="group in detailGroups" :key="group.title" class="glass-card p-5">
        <h2 class="mb-4 text-lg font-semibold text-content-heading dark:text-white">
          {{ group.title }}
        </h2>
        <div class="grid grid-cols-[minmax(110px,0.75fr)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <template v-for="row in group.rows" :key="`${group.title}-${row[0]}`">
            <div class="text-content-muted">{{ row[0] }}</div>
            <div class="break-words font-medium text-content-primary dark:text-white">
              {{ formatValue(row[1], row[2]) }}
            </div>
          </template>
        </div>
      </section>
    </div>

    <section class="glass-card p-5">
      <h2 class="mb-4 text-lg font-semibold text-content-heading dark:text-white">
        Satellites In View + SNR
      </h2>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[560px] text-left text-sm">
          <thead class="border-b border-stroke-subtle text-xs uppercase text-content-muted">
            <tr>
              <th class="py-2 pr-4 font-semibold">PRN</th>
              <th class="py-2 pr-4 font-semibold">Elevation</th>
              <th class="py-2 pr-4 font-semibold">Azimuth</th>
              <th class="py-2 pr-4 font-semibold">SNR</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-stroke-subtle dark:divide-white/10">
            <tr v-for="satellite in visibleSatellites" :key="String(satellite.prn)">
              <td class="py-2 pr-4 text-content-primary dark:text-white">
                {{ formatValue(satellite.prn) }}
              </td>
              <td class="py-2 pr-4">{{ formatValue(satellite.elevation_degrees, 'deg') }}</td>
              <td class="py-2 pr-4">{{ formatValue(satellite.azimuth_degrees, 'deg') }}</td>
              <td class="py-2 pr-4">{{ formatValue(satellite.snr_db, 'dB') }}</td>
            </tr>
            <tr v-if="visibleSatellites.length === 0">
              <td colspan="4" class="py-6 text-center text-content-muted">
                No satellites in view yet
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="glass-card p-5">
      <h2 class="mb-4 text-lg font-semibold text-content-heading dark:text-white">
        Recent NMEA Sentences
      </h2>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] text-left text-sm">
          <thead class="border-b border-stroke-subtle text-xs uppercase text-content-muted">
            <tr>
              <th class="py-2 pr-4 font-semibold">Timestamp</th>
              <th class="py-2 pr-4 font-semibold">Type</th>
              <th class="py-2 pr-4 font-semibold">Sentence</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-stroke-subtle dark:divide-white/10">
            <tr
              v-for="sentence in recentSentences"
              :key="`${sentence.timestamp}-${sentence.sentence}`"
            >
              <td class="py-2 pr-4 whitespace-nowrap">
                {{ formatValue(sentence.timestamp) }}
              </td>
              <td class="py-2 pr-4">{{ formatValue(sentence.sentence_type) }}</td>
              <td class="py-2 pr-4 font-mono text-xs">{{ formatValue(sentence.sentence) }}</td>
            </tr>
            <tr v-if="recentSentences.length === 0">
              <td colspan="3" class="py-6 text-center text-content-muted">
                No NMEA sentences captured yet
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="glass-card p-5">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold text-content-heading dark:text-white">Raw Snapshot</h2>
        <button
          type="button"
          class="rounded-[10px] border border-stroke-subtle dark:border-white/10 bg-white/70 dark:bg-white/10 px-3 py-1.5 text-xs font-semibold text-content-primary dark:text-white hover:bg-white dark:hover:bg-white/20"
          @click="showRawSnapshot = !showRawSnapshot"
        >
          {{ showRawSnapshot ? 'Hide' : 'Show' }}
        </button>
      </div>
      <pre
        v-if="showRawSnapshot"
        class="max-h-[440px] overflow-auto rounded-[10px] border border-stroke-subtle bg-background-soft p-4 text-xs text-content-primary dark:border-white/10 dark:bg-black/20 dark:text-white"
        >{{ rawSnapshot }}</pre
      >
    </section>
  </div>
</template>

<style scoped>
.globe-stage {
  position: relative;
  min-height: 330px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  background:
    radial-gradient(
      circle at 50% 46%,
      color-mix(in srgb, var(--color-primary) 24%, transparent),
      transparent 34%
    ),
    radial-gradient(circle at 48% 50%, rgba(255, 255, 255, 0.14), transparent 20%),
    linear-gradient(145deg, var(--color-background-soft), var(--color-background));
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}

.globe-stage:active {
  cursor: grabbing;
}

.globe-stage canvas {
  display: block;
  width: 100%;
  height: 330px;
}

.globe-tooltip {
  position: absolute;
  z-index: 2;
  min-width: 154px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  background: rgba(5, 10, 12, 0.92);
  color: #ffffff;
  padding: 10px 11px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.36);
  pointer-events: none;
  transform: translate(-50%, calc(-100% - 22px));
}

.tooltip-title {
  color: var(--color-accent-green);
  font-size: 0.82rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.tooltip-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  margin-top: 7px;
  font-size: 0.78rem;
}

.tooltip-key {
  color: rgba(255, 255, 255, 0.66);
}

.tooltip-value {
  color: #ffffff;
  font-weight: 700;
  text-align: right;
}

.globe-fallback {
  position: absolute;
  inset: 0;
  padding: 18px;
}

.fallback-sky {
  position: relative;
  width: min(250px, 72vw);
  aspect-ratio: 1;
  margin: 0 auto;
  border: 1px solid color-mix(in srgb, var(--color-primary) 34%, var(--color-border-subtle));
  border-radius: 50%;
  background:
    radial-gradient(
      circle,
      color-mix(in srgb, var(--color-primary) 18%, transparent) 0 2px,
      transparent 3px
    ),
    repeating-radial-gradient(
      circle,
      transparent 0 31%,
      color-mix(in srgb, var(--color-border) 70%, transparent) 31.5% 32%,
      transparent 32.5% 49%
    ),
    linear-gradient(
      90deg,
      transparent 49.7%,
      color-mix(in srgb, var(--color-border) 78%, transparent) 49.7% 50.3%,
      transparent 50.3%
    ),
    linear-gradient(
      0deg,
      transparent 49.7%,
      color-mix(in srgb, var(--color-border) 78%, transparent) 49.7% 50.3%,
      transparent 50.3%
    );
}

.fallback-sat {
  position: absolute;
  width: var(--size);
  height: var(--size);
  border-radius: 999px;
  background: var(--color-primary);
  box-shadow: 0 0 16px color-mix(in srgb, var(--color-primary) 70%, transparent);
  transform: translate(-50%, -50%);
}

.fallback-sat-used {
  background: var(--color-accent-green);
  box-shadow: 0 0 16px color-mix(in srgb, var(--color-accent-green) 70%, transparent);
}

.fallback-sat span {
  position: absolute;
  top: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  color: var(--color-text-primary);
  font-size: 0.65rem;
  font-weight: 700;
  white-space: nowrap;
}

.sky-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  pointer-events: none;
}
</style>
