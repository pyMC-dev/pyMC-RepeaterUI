<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ApiService, { API_SERVER_URL } from '@/utils/api';
import { getToken } from '@/utils/auth';
import type { GPSDiagnostics, GPSSatellite } from '@/types/api';

defineOptions({ name: 'GPSDiagnosticsView' });

type DetailRow = [string, unknown, string?];

const gps = ref<GPSDiagnostics | null>(null);
const isLoading = ref(true);
const error = ref<string | null>(null);
const lastLoaded = ref<Date | null>(null);
const showRawSnapshot = ref(false);
const eventSource = ref<EventSource | null>(null);

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

const skySatellites = computed(() => {
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
      };
    })
    .filter((satellite): satellite is NonNullable<typeof satellite> => satellite !== null);
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
              Satellite Sky
            </h2>
            <p class="text-xs text-content-muted">
              {{ skySatellites.length }} satellite{{ skySatellites.length === 1 ? '' : 's' }}
              plotted from GSV azimuth, elevation, and SNR.
            </p>
          </div>
          <span
            class="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary"
          >
            {{ formatValue(positionMeta.source_label) }}
          </span>
        </div>

        <div class="gps-sky">
          <svg viewBox="0 0 200 200" role="img" aria-label="Satellite sky plot">
            <circle cx="100" cy="100" r="83" class="sky-ring-outer" />
            <circle cx="100" cy="100" r="55" class="sky-ring" />
            <circle cx="100" cy="100" r="28" class="sky-ring" />
            <line x1="100" y1="17" x2="100" y2="183" class="sky-axis" />
            <line x1="17" y1="100" x2="183" y2="100" class="sky-axis" />
            <text x="100" y="13" text-anchor="middle" class="sky-cardinal">N</text>
            <text x="190" y="104" text-anchor="middle" class="sky-cardinal">E</text>
            <text x="100" y="194" text-anchor="middle" class="sky-cardinal">S</text>
            <text x="10" y="104" text-anchor="middle" class="sky-cardinal">W</text>
            <circle cx="100" cy="100" r="3.5" class="receiver-dot" />

            <g v-for="satellite in skySatellites" :key="satellite.key">
              <line
                x1="100"
                y1="100"
                :x2="satellite.x"
                :y2="satellite.y"
                :class="satellite.used ? 'sat-link-used' : 'sat-link'"
              />
              <circle
                :cx="satellite.x"
                :cy="satellite.y"
                :r="satellite.size"
                :class="satellite.used ? 'sat-dot-used' : 'sat-dot'"
              >
                <title>
                  SAT {{ satellite.prn }} | SNR {{ formatValue(satellite.snr, 'dB') }} | El
                  {{ formatValue(satellite.elevation, 'deg') }} | Az
                  {{ formatValue(satellite.azimuth, 'deg') }}
                </title>
              </circle>
              <text
                :x="satellite.x"
                :y="satellite.y - satellite.size - 3"
                text-anchor="middle"
                class="sat-label"
              >
                {{ satellite.prn }}
              </text>
            </g>
          </svg>

          <div v-if="skySatellites.length === 0" class="sky-empty">No satellites in view yet</div>
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
.gps-sky {
  position: relative;
  min-height: 330px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  background:
    radial-gradient(
      circle at 50% 45%,
      color-mix(in srgb, var(--color-primary) 18%, transparent),
      transparent 38%
    ),
    linear-gradient(145deg, var(--color-background-soft), var(--color-background));
  overflow: hidden;
}

.gps-sky svg {
  display: block;
  width: 100%;
  height: 330px;
}

.sky-ring-outer {
  fill: color-mix(in srgb, var(--color-primary) 7%, transparent);
  stroke: color-mix(in srgb, var(--color-primary) 40%, transparent);
  stroke-width: 1.2;
}

.sky-ring {
  fill: none;
  stroke: color-mix(in srgb, var(--color-border) 56%, transparent);
  stroke-width: 0.8;
}

.sky-axis {
  stroke: color-mix(in srgb, var(--color-border) 54%, transparent);
  stroke-width: 0.7;
}

.sky-cardinal,
.sat-label {
  fill: var(--color-text-muted);
  font-size: 7px;
  font-weight: 700;
}

.receiver-dot {
  fill: var(--color-accent-green);
}

.sat-link,
.sat-link-used {
  stroke-width: 0.7;
}

.sat-link {
  stroke: color-mix(in srgb, var(--color-primary) 48%, transparent);
}

.sat-link-used {
  stroke: color-mix(in srgb, var(--color-accent-green) 58%, transparent);
}

.sat-dot,
.sat-dot-used {
  stroke: rgba(255, 255, 255, 0.7);
  stroke-width: 1;
}

.sat-dot {
  fill: var(--color-primary);
}

.sat-dot-used {
  fill: var(--color-accent-green);
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
