<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useSystemStore } from '@/stores/system';
import { authClient } from '@/utils/api';

const systemStore = useSystemStore();

const letsmeshConfig = computed(() => systemStore.stats?.config?.letsmesh || {});

// Available packet types the user can block
const ALL_PACKET_TYPES = [
  'REQ',
  'RESPONSE',
  'TXT_MSG',
  'ACK',
  'ADVERT',
  'GRP_TXT',
  'GRP_DATA',
  'ANON_REQ',
  'PATH',
  'TRACE',
  'RAW_CUSTOM',
];

const BROKER_OPTIONS = [
  { value: 0, label: 'Letsmesh Europe only (EU v1)' },
  { value: 1, label: 'Letsmesh US West only (US v1)' },
  { value: -1, label: 'All built-in brokers (EU + US)' },
  { value: -2, label: 'Custom brokers only' },
];

// ── broker templates (add new entries here to extend the list) ──────────────
interface BrokerTemplate {
  name: string; // display name for the network
  website: string; // link shown next to the template
  brokers: Omit<CustomBroker, '_id'>[];
}

const BROKER_TEMPLATES: BrokerTemplate[] = [

  {
    name: 'waev.app',
    website: 'https://waev.app',
    brokers: [
      { name: 'waev.app (Primary)', host: 'mqtt-a.waev.app', port: 443, audience: 'mqtt.waev.app' },
      { name: 'waev.app (Secondary)', host: 'mqtt-b.waev.app', port: 443, audience: 'mqtt.waev.app' },
    ],
  },
    {
    name: 'MeshMapper',
    website: 'https://meshmapper.net',
    brokers: [
      { name: 'MeshMapper', host: 'mqtt.meshmapper.cc', port: 443, audience: 'mqtt.meshmapper.cc' },
    ],
  },
];

// ── custom broker type ────────────────────────────────────────────────────────
interface CustomBroker {
  _id: number; // local tracking key, not sent to API
  name: string;
  host: string;
  port: number;
  audience: string;
}

// ── form state ────────────────────────────────────────────────────────────────
const isEditing = ref(false);
const isSaving = ref(false);
const successMsg = ref('');
const errorMsg = ref('');

const enabledInput = ref(false);
const iataCodeInput = ref('');
const brokerIndexInput = ref(0);
const statusIntervalInput = ref(300);
const ownerInput = ref('');
const emailInput = ref('');
const disallowedInput = ref<string[]>([]);
const customBrokers = ref<CustomBroker[]>([]);

// ── inline broker edit state ──────────────────────────────────────────────────
const editingBrokerId = ref<number | null>(null);
const brokerDraft = ref<CustomBroker>({ _id: 0, name: '', host: '', port: 443, audience: '' });
const showTemplateMenu = ref(false);

function addFromTemplate(tpl: BrokerTemplate) {
  showTemplateMenu.value = false;
  // commit any open edit first
  if (editingBrokerId.value !== null) saveBrokerEdit();
  tpl.brokers.forEach((b) => {
    const broker = mkBroker(b);
    customBrokers.value.push(broker);
  });
}

let _nextId = 1;
function mkBroker(b: Partial<Omit<CustomBroker, '_id'>> = {}): CustomBroker {
  return {
    _id: _nextId++,
    name: b.name ?? '',
    host: b.host ?? '',
    port: b.port ?? 443,
    audience: b.audience ?? '',
  };
}

function addBroker() {
  const b = mkBroker();
  customBrokers.value.push(b);
  brokerDraft.value = { ...b };
  editingBrokerId.value = b._id;
}

function removeBroker(id: number) {
  customBrokers.value = customBrokers.value.filter((b) => b._id !== id);
  if (editingBrokerId.value === id) editingBrokerId.value = null;
}

function openBrokerEdit(broker: CustomBroker) {
  brokerDraft.value = { ...broker };
  editingBrokerId.value = broker._id;
}

function closeBrokerEdit() {
  editingBrokerId.value = null;
}

function saveBrokerEdit() {
  const d = brokerDraft.value;
  if (!d.name.trim() || !d.host.trim() || !d.audience.trim()) return;
  const idx = customBrokers.value.findIndex((b) => b._id === d._id);
  if (idx !== -1) customBrokers.value.splice(idx, 1, { ...d });
  editingBrokerId.value = null;
}

// mirror host → audience when audience is still blank or was equal to old host
function onHostChange() {
  const d = brokerDraft.value;
  const orig = customBrokers.value.find((b) => b._id === d._id);
  if (!d.audience || d.audience === (orig?.host ?? '')) {
    d.audience = d.host;
  }
}

// ── per-broker validation ─────────────────────────────────────────────────────
const brokerErrors = computed(() => {
  const errors: Record<number, string> = {};
  customBrokers.value.forEach((b) => {
    if (!b.name.trim()) errors[b._id] = 'Name required';
    else if (!b.host.trim()) errors[b._id] = 'Host required';
    else if (!b.audience.trim()) errors[b._id] = 'Audience required';
    else if (b.port < 1 || b.port > 65535) errors[b._id] = 'Port must be 1–65535';
  });
  return errors;
});
const hasValidationErrors = computed(() => Object.keys(brokerErrors.value).length > 0);

// ── live status ───────────────────────────────────────────────────────────────
const status = ref<{
  enabled: boolean;
  handler_active: boolean;
  brokers: { name: string; host: string; connected: boolean; reconnecting: boolean }[];
} | null>(null);
const loadingStatus = ref(false);

async function fetchStatus() {
  loadingStatus.value = true;
  try {
    const res = await authClient.get('/api/letsmesh_status');
    if (res.data?.success) status.value = res.data.data;
  } catch {
    /* silent */
  } finally {
    loadingStatus.value = false;
  }
}

// ── sync form from store ───────────────────────────────────────────────────────
function syncForm() {
  const c = letsmeshConfig.value;
  enabledInput.value = c.enabled ?? false;
  iataCodeInput.value = c.iata_code ?? '';
  brokerIndexInput.value = c.broker_index ?? 0;
  statusIntervalInput.value = c.status_interval ?? 300;
  ownerInput.value = c.owner ?? '';
  emailInput.value = c.email ?? '';
  disallowedInput.value = Array.isArray(c.disallowed_packet_types)
    ? [...c.disallowed_packet_types]
    : [];
  customBrokers.value = Array.isArray(c.additional_brokers)
    ? (c.additional_brokers as Record<string, unknown>[]).map((b) =>
      mkBroker(b as Partial<Omit<CustomBroker, '_id'>>),
    )
    : [];
}

watch(
  letsmeshConfig,
  () => {
    if (!isEditing.value) syncForm();
  },
  { immediate: true },
);

function startEditing() {
  syncForm();
  editingBrokerId.value = null;
  isEditing.value = true;
  successMsg.value = '';
  errorMsg.value = '';
}

function cancelEditing() {
  editingBrokerId.value = null;
  isEditing.value = false;
  successMsg.value = '';
  errorMsg.value = '';
}

function toggleDisallowed(type: string) {
  const idx = disallowedInput.value.indexOf(type);
  if (idx === -1) disallowedInput.value.push(type);
  else disallowedInput.value.splice(idx, 1);
}

async function saveChanges() {
  // commit any open inline broker edit first
  if (editingBrokerId.value !== null) saveBrokerEdit();
  if (hasValidationErrors.value) {
    errorMsg.value = 'Please fix broker errors before saving.';
    return;
  }
  isSaving.value = true;
  errorMsg.value = '';
  successMsg.value = '';
  try {
    const res = await authClient.post('/api/update_letsmesh_config', {
      enabled: enabledInput.value,
      iata_code: iataCodeInput.value,
      broker_index: brokerIndexInput.value,
      status_interval: statusIntervalInput.value,
      owner: ownerInput.value,
      email: emailInput.value,
      disallowed_packet_types: disallowedInput.value,
      additional_brokers: customBrokers.value.map(({ name, host, port, audience }) => ({
        name,
        host,
        port,
        audience,
      })),
    });
    const data = res.data;
    if (data?.success) {
      successMsg.value = data.data?.message || 'Settings saved';
      isEditing.value = false;
      await systemStore.fetchStats();
      await fetchStatus();
      setTimeout(() => {
        successMsg.value = '';
      }, 5000);
    } else {
      errorMsg.value = data?.error || 'Save failed';
    }
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    errorMsg.value = e?.response?.data?.error || e?.message || 'Request failed';
  } finally {
    isSaving.value = false;
  }
}

onMounted(fetchStatus);
</script>

<template>
  <div class="space-y-6">
    <!-- ── Live Connection Status ─────────────────────────────────────────── -->
    <div class="glass-card rounded-lg border border-stroke-subtle dark:border-stroke/10 p-6">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-lg font-semibold text-content-primary dark:text-content-primary mb-1">
            Observer Status
          </h3>
          <p class="text-sm text-content-secondary dark:text-content-muted">
            Live broker connection state
          </p>
        </div>
        <button @click="fetchStatus" :disabled="loadingStatus"
          class="px-3 py-1.5 text-xs rounded-lg bg-cyan-500/10 dark:bg-primary/10 hover:bg-cyan-500/20 dark:hover:bg-primary/20 text-cyan-700 dark:text-primary border border-cyan-400/30 dark:border-primary/30 transition-colors disabled:opacity-50">
          <span v-if="loadingStatus">Refreshing…</span>
          <span v-else>↻ Refresh</span>
        </button>
      </div>

      <div v-if="!status" class="text-sm text-content-secondary dark:text-content-muted">
        Status unavailable — service may not be running.
      </div>
      <div v-else class="space-y-3">
        <!-- handler pill -->
        <div class="flex items-center gap-2">
          <span class="text-sm text-content-secondary dark:text-content-muted w-36">Handler</span>
          <span :class="[
            'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium',
            status.handler_active
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
              : 'bg-gray-100 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400',
          ]">
            <span class="w-1.5 h-1.5 rounded-full"
              :class="status.handler_active ? 'bg-green-500' : 'bg-gray-400'"></span>
            {{ status.handler_active ? 'Active' : 'Inactive' }}
          </span>
        </div>

        <!-- broker rows -->
        <div v-if="status.brokers.length" class="space-y-2">
          <div v-for="broker in status.brokers" :key="broker.host" class="flex items-center gap-2">
            <span class="text-sm text-content-secondary dark:text-content-muted w-36 truncate" :title="broker.name">{{
              broker.name }}</span>
            <span :class="[
              'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium',
              broker.connected
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : broker.reconnecting
                  ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                  : 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
            ]">
              <span class="w-1.5 h-1.5 rounded-full" :class="broker.connected
                  ? 'bg-green-500'
                  : broker.reconnecting
                    ? 'bg-amber-500'
                    : 'bg-red-500'
                "></span>
              {{
                broker.connected
                  ? 'Connected'
                  : broker.reconnecting
                    ? 'Reconnecting…'
                    : 'Disconnected'
              }}
            </span>
          </div>
        </div>
        <div v-else class="text-sm text-content-muted dark:text-content-muted/60 italic">
          No broker connections configured.
        </div>
      </div>
    </div>

    <!-- ── Configuration Card ─────────────────────────────────────────────── -->
    <div class="glass-card rounded-lg border border-stroke-subtle dark:border-stroke/10 p-6">
      <div class="flex items-start justify-between mb-6">
        <div>
          <h3 class="text-lg font-semibold text-content-primary dark:text-content-primary mb-1">
            Observer Configuration
          </h3>
          <p class="text-sm text-content-secondary dark:text-content-muted">
            Configure MQTT observer settings
          </p>
        </div>
        <button v-if="!isEditing" @click="startEditing"
          class="px-4 py-2 text-sm rounded-lg bg-cyan-500/10 dark:bg-primary/10 hover:bg-cyan-500/20 dark:hover:bg-primary/20 text-cyan-700 dark:text-primary border border-cyan-400/30 dark:border-primary/30 transition-colors">
          Edit
        </button>
      </div>

      <!-- ── View mode ────────────────────────────────────────────────────── -->
      <div v-if="!isEditing" class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
          <div>
            <span
              class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">Enabled</span>
            <p class="mt-1 text-sm text-content-primary dark:text-content-primary">
              <span :class="[
                'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium',
                letsmeshConfig.enabled
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                  : 'bg-gray-100 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400',
              ]">
                {{ letsmeshConfig.enabled ? 'Yes' : 'No' }}
              </span>
            </p>
          </div>

          <div>
            <span
              class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">IATA
              Code</span>
            <p class="mt-1 text-sm text-content-primary dark:text-content-primary font-mono">
              {{ letsmeshConfig.iata_code || '—' }}
            </p>
          </div>

          <div>
            <span
              class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">Broker
              Mode</span>
            <p class="mt-1 text-sm text-content-primary dark:text-content-primary">
              {{
                BROKER_OPTIONS.find((o) => o.value === letsmeshConfig.broker_index)?.label ??
                `Index ${letsmeshConfig.broker_index ?? 0}`
              }}
            </p>
          </div>

          <div>
            <span
              class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">Status
              Interval</span>
            <p class="mt-1 text-sm text-content-primary dark:text-content-primary">
              {{ letsmeshConfig.status_interval ?? 300 }}s
            </p>
          </div>

          <div>
            <span
              class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">Owner</span>
            <p class="mt-1 text-sm text-content-primary dark:text-content-primary">
              {{ letsmeshConfig.owner || '—' }}
            </p>
          </div>

          <div>
            <span
              class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">Email</span>
            <p class="mt-1 text-sm text-content-primary dark:text-content-primary">
              {{ letsmeshConfig.email || '—' }}
            </p>
          </div>
        </div>

        <!-- Custom brokers read-only list -->
        <div>
          <span
            class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">Custom
            Brokers</span>
          <div v-if="!letsmeshConfig.additional_brokers?.length"
            class="mt-2 text-sm text-content-muted dark:text-content-muted/60 italic">
            None configured
          </div>
          <div v-else class="mt-2 space-y-1.5">
            <div v-for="b in letsmeshConfig.additional_brokers" :key="b.host"
              class="flex items-center gap-3 px-3 py-2 rounded-lg bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/10">
              <div class="min-w-0 flex-1">
                <span class="text-sm font-medium text-content-primary dark:text-content-primary">{{
                  b.name
                  }}</span>
                <span class="text-xs text-content-secondary dark:text-content-muted ml-2 font-mono">{{ b.host }}:{{
                  b.port }}</span>
              </div>
              <span class="text-xs text-content-secondary dark:text-content-muted font-mono truncate max-w-[140px]"
                :title="b.audience">{{ b.audience }}</span>
            </div>
          </div>
        </div>

        <div>
          <span
            class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">Blocked
            Packet Types</span>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <span v-if="!letsmeshConfig.disallowed_packet_types?.length"
              class="text-sm text-content-muted dark:text-content-muted/60 italic">All types allowed</span>
            <span v-for="t in letsmeshConfig.disallowed_packet_types" :key="t"
              class="px-2 py-0.5 rounded text-xs font-mono bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">{{
              t }}</span>
          </div>
        </div>
      </div>

      <!-- ── Edit mode ─────────────────────────────────────────────────────── -->
      <div v-else class="space-y-5">
        <!-- Enable toggle -->
        <div
          class="flex items-center justify-between p-4 rounded-lg bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/10">
          <div>
            <label class="text-sm font-medium text-content-primary dark:text-content-primary">Enable Observer</label>
            <p class="text-xs text-content-secondary dark:text-content-muted mt-0.5">
              Publish mesh packets to the MQTT networks
            </p>
          </div>
          <button @click="enabledInput = !enabledInput" :class="[
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors border-2',
            enabledInput
              ? 'bg-cyan-600 dark:bg-teal-500 border-cyan-600 dark:border-teal-500'
              : 'bg-gray-400 dark:bg-gray-600 border-gray-400 dark:border-gray-600',
          ]">
            <span :class="[
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-lg',
              enabledInput ? 'translate-x-5' : 'translate-x-0.5',
            ]" />
          </button>
        </div>

        <!-- IATA Code + Broker mode -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-content-primary dark:text-content-primary mb-1.5">
              IATA Code
              <span class="text-content-secondary dark:text-content-muted font-normal text-xs ml-1">(e.g. SFO,
                LHR)</span>
            </label>
            <input v-model="iataCodeInput" type="text" maxlength="10" placeholder="TEST"
              class="w-full px-3 py-2 text-sm rounded-lg bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary placeholder-content-muted dark:placeholder-content-muted/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40 font-mono" />
          </div>
          <div>
            <label class="block text-sm font-medium text-content-primary dark:text-content-primary mb-1.5">Broker
              Mode</label>
            <select v-model.number="brokerIndexInput"
              class="w-full px-3 py-2 text-sm rounded-lg bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40">
              <option v-for="opt in BROKER_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
        </div>

        <!-- Owner + Email -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-content-primary dark:text-content-primary mb-1.5">Owner /
              Callsign</label>
            <input v-model="ownerInput" type="text" placeholder="Optional"
              class="w-full px-3 py-2 text-sm rounded-lg bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary placeholder-content-muted dark:placeholder-content-muted/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40" />
          </div>
          <div>
            <label class="block text-sm font-medium text-content-primary dark:text-content-primary mb-1.5">Email</label>
            <input v-model="emailInput" type="email" placeholder="Optional"
              class="w-full px-3 py-2 text-sm rounded-lg bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary placeholder-content-muted dark:placeholder-content-muted/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40" />
          </div>
        </div>

        <!-- Status Interval -->
        <div>
          <label class="block text-sm font-medium text-content-primary dark:text-content-primary mb-1.5">
            Status Heartbeat Interval
            <span class="text-content-secondary dark:text-content-muted font-normal text-xs ml-1">(seconds, min
              60)</span>
          </label>
          <input v-model.number="statusIntervalInput" type="number" min="60" max="3600"
            class="w-32 px-3 py-2 text-sm rounded-lg bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40 font-mono" />
        </div>

        <!-- ── Custom Brokers manager ───────────────────────────────────────── -->
        <div>
          <div class="flex items-start justify-between mb-3 gap-3">
            <div class="min-w-0">
              <label class="text-sm font-medium text-content-primary dark:text-content-primary">Custom Brokers</label>
              <p class="text-xs text-content-secondary dark:text-content-muted mt-0.5">
                Additional MQTT/WebSocket brokers alongside or instead of built-in ones
              </p>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <!-- Add from template dropdown -->
              <div class="relative">
                <button @click="showTemplateMenu = !showTemplateMenu"
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-background-mute dark:bg-background/30 hover:bg-stroke-subtle dark:hover:bg-stroke/10 text-content-secondary dark:text-content-muted border border-stroke-subtle dark:border-stroke/20 transition-colors">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M19 11H5m14 0l-4-4m4 4l-4 4" />
                  </svg>
                  From Template
                  <svg class="w-3 h-3 ml-0.5 transition-transform" :class="showTemplateMenu ? 'rotate-180' : ''"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                <!-- Dropdown menu -->
                <Transition name="dropdown">
                  <div v-if="showTemplateMenu"
                    class="absolute right-0 top-full mt-1 z-20 w-64 rounded-lg shadow-lg border border-stroke-subtle dark:border-stroke/20 bg-white dark:bg-[var(--color-surface)] overflow-hidden">
                    <div class="px-3 py-2 border-b border-stroke-subtle dark:border-stroke/10">
                      <p
                        class="text-xs font-medium text-content-secondary dark:text-content-muted uppercase tracking-wide">
                        Known Networks
                      </p>
                    </div>
                    <div class="py-1">
                      <div v-for="tpl in BROKER_TEMPLATES" :key="tpl.name"
                        class="flex items-center gap-2 px-3 py-2.5 hover:bg-background-mute dark:hover:bg-background/30 cursor-pointer group"
                        @click="addFromTemplate(tpl)">
                        <div class="min-w-0 flex-1">
                          <p
                            class="text-sm font-medium text-content-primary dark:text-content-primary group-hover:text-cyan-700 dark:group-hover:text-primary transition-colors">
                            {{ tpl.name }}
                          </p>
                          <p class="text-xs text-content-secondary dark:text-content-muted">
                            {{ tpl.brokers.length }} broker{{ tpl.brokers.length !== 1 ? 's' : '' }}
                          </p>
                        </div>
                        <a :href="tpl.website" target="_blank" rel="noopener noreferrer" title="Visit website"
                          class="flex-shrink-0 p-1 rounded hover:bg-cyan-500/10 dark:hover:bg-primary/10 text-content-secondary dark:text-content-muted hover:text-cyan-700 dark:hover:text-primary transition-colors"
                          @click.stop>
                          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      </div>
                    </div>
                  </div>
                </Transition>
                <!-- click-away overlay -->
                <div v-if="showTemplateMenu" class="fixed inset-0 z-10" @click="showTemplateMenu = false" />
              </div>

              <!-- Manual add button -->
              <button @click="addBroker"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cyan-500/10 dark:bg-primary/10 hover:bg-cyan-500/20 dark:hover:bg-primary/20 text-cyan-700 dark:text-primary border border-cyan-400/30 dark:border-primary/30 transition-colors">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                Add
              </button>
            </div>
          </div>

          <!-- Empty state -->
          <div v-if="!customBrokers.length"
            class="flex flex-col items-center justify-center py-7 rounded-lg border-2 border-dashed border-stroke-subtle dark:border-stroke/20 text-content-secondary dark:text-content-muted">
            <svg class="w-7 h-7 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 12h14M5 12l4-4m-4 4l4 4" />
            </svg>
            <p class="text-sm">No custom brokers</p>
            <p class="text-xs mt-0.5 opacity-70">
              Built-in brokers will be used based on the mode above
            </p>
          </div>

          <!-- Broker list -->
          <div v-else class="space-y-2">
            <div v-for="broker in customBrokers" :key="broker._id" :class="[
              'rounded-lg border overflow-hidden transition-colors',
              brokerErrors[broker._id]
                ? 'border-red-300 dark:border-red-700/50'
                : 'border-stroke-subtle dark:border-stroke/10',
            ]">
              <!-- Collapsed summary row -->
              <div v-if="editingBrokerId !== broker._id" class="flex items-center gap-3 px-4 py-2.5">
                <div class="min-w-0 flex-1">
                  <span class="text-sm font-medium text-content-primary dark:text-content-primary">{{ broker.name ||
                    '(unnamed)' }}</span>
                  <span class="text-xs font-mono text-content-secondary dark:text-content-muted ml-2">{{ broker.host ||
                    '—' }}:{{ broker.port }}</span>
                  <span v-if="brokerErrors[broker._id]" class="ml-2 text-xs text-red-500 dark:text-red-400">{{
                    brokerErrors[broker._id] }}</span>
                </div>
                <div class="flex items-center gap-0.5 flex-shrink-0">
                  <button @click="openBrokerEdit(broker)" title="Edit"
                    class="p-1.5 rounded hover:bg-cyan-500/10 dark:hover:bg-primary/10 text-content-secondary dark:text-content-muted hover:text-cyan-700 dark:hover:text-primary transition-colors">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button @click="removeBroker(broker._id)" title="Remove"
                    class="p-1.5 rounded hover:bg-red-500/10 dark:hover:bg-red-900/20 text-content-secondary dark:text-content-muted hover:text-red-600 dark:hover:text-red-400 transition-colors">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- Expanded inline edit form -->
              <div v-else class="p-4 space-y-3 bg-background-mute/60 dark:bg-background/20">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <!-- Name -->
                  <div>
                    <label class="block text-xs font-medium text-content-secondary dark:text-content-muted mb-1">
                      Name <span class="text-red-500">*</span>
                    </label>
                    <input v-model="brokerDraft.name" type="text" placeholder="My Private Broker"
                      class="w-full px-3 py-1.5 text-sm rounded-md bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary placeholder-content-muted dark:placeholder-content-muted/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40" />
                  </div>
                  <!-- Port -->
                  <div>
                    <label class="block text-xs font-medium text-content-secondary dark:text-content-muted mb-1">
                      Port <span class="text-red-500">*</span>
                    </label>
                    <input v-model.number="brokerDraft.port" type="number" min="1" max="65535" placeholder="443"
                      class="w-full px-3 py-1.5 text-sm rounded-md bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary placeholder-content-muted dark:placeholder-content-muted/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40 font-mono" />
                  </div>
                  <!-- Host -->
                  <div>
                    <label class="block text-xs font-medium text-content-secondary dark:text-content-muted mb-1">
                      Host <span class="text-red-500">*</span>
                    </label>
                    <input v-model="brokerDraft.host" type="text" placeholder="mqtt.myserver.com" @input="onHostChange"
                      class="w-full px-3 py-1.5 text-sm rounded-md bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary placeholder-content-muted dark:placeholder-content-muted/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40 font-mono" />
                  </div>
                  <!-- Audience -->
                  <div>
                    <label class="block text-xs font-medium text-content-secondary dark:text-content-muted mb-1">
                      Audience <span class="text-red-500">*</span>
                      <span class="font-normal text-content-muted dark:text-content-muted/60 ml-1">(JWT aud — usually
                        same as host)</span>
                    </label>
                    <input v-model="brokerDraft.audience" type="text" placeholder="mqtt.myserver.com"
                      class="w-full px-3 py-1.5 text-sm rounded-md bg-background-mute dark:bg-background/30 border border-stroke-subtle dark:border-stroke/20 text-content-primary dark:text-content-primary placeholder-content-muted dark:placeholder-content-muted/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-primary/40 font-mono" />
                  </div>
                </div>
                <div class="flex items-center gap-2 pt-1">
                  <button @click="saveBrokerEdit" :disabled="!brokerDraft.name.trim() ||
                    !brokerDraft.host.trim() ||
                    !brokerDraft.audience.trim()
                    "
                    class="px-3 py-1.5 text-xs font-medium rounded-md bg-cyan-600 dark:bg-teal-600 hover:bg-cyan-700 dark:hover:bg-teal-700 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    Done
                  </button>
                  <button @click="closeBrokerEdit"
                    class="px-3 py-1.5 text-xs rounded-md border border-stroke-subtle dark:border-stroke/20 hover:bg-stroke-subtle dark:hover:bg-stroke/10 text-content-secondary dark:text-content-muted transition-colors">
                    Cancel
                  </button>
                  <button @click="removeBroker(broker._id)"
                    class="ml-auto px-3 py-1.5 text-xs rounded-md border border-red-300/60 dark:border-red-700/30 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 transition-colors">
                    Remove
                  </button>
                </div>
              </div>
            </div>
          </div>

          <p class="mt-2 text-xs text-content-secondary dark:text-content-muted">
            Set <span class="font-medium">Broker Mode</span> to <em>Custom brokers only</em> to use
            exclusively these servers, or leave it on any other mode to use them alongside the
            built-in ones.
          </p>
        </div>

        <!-- Blocked packet types -->
        <div>
          <label class="block text-sm font-medium text-content-primary dark:text-content-primary mb-2">
            Block Packet Types
            <span class="text-content-secondary dark:text-content-muted font-normal text-xs ml-1">(prevent publishing to
              LetsMesh)</span>
          </label>
          <div class="flex flex-wrap gap-2">
            <button v-for="type in ALL_PACKET_TYPES" :key="type" @click="toggleDisallowed(type)" :class="[
              'px-2.5 py-1 rounded text-xs font-mono font-medium border transition-colors',
              disallowedInput.includes(type)
                ? 'bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700/50 text-red-700 dark:text-red-400'
                : 'bg-background-mute dark:bg-background/30 border-stroke-subtle dark:border-stroke/20 text-content-secondary dark:text-content-muted hover:border-cyan-400/50 dark:hover:border-primary/40',
            ]">
              {{ type }}
            </button>
          </div>
          <p class="mt-1.5 text-xs text-content-secondary dark:text-content-muted">
            <span class="text-red-600 dark:text-red-400 font-medium">Red = blocked.</span>
            Leave all unselected to publish all packet types.
          </p>
        </div>

        <!-- Restart notice -->
        <div
          class="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 text-amber-700 dark:text-amber-400 text-xs">
          <svg class="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          A service restart is required for changes to take effect.
        </div>

        <!-- Success / error feedback -->
        <div v-if="successMsg"
          class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700/30 text-green-700 dark:text-green-400 text-sm">
          {{ successMsg }}
        </div>
        <div v-if="errorMsg"
          class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 text-red-700 dark:text-red-400 text-sm">
          {{ errorMsg }}
        </div>

        <!-- Action buttons -->
        <div class="flex items-center gap-3 pt-2">
          <button @click="saveChanges" :disabled="isSaving || hasValidationErrors"
            class="px-5 py-2 text-sm font-medium rounded-lg bg-cyan-600 dark:bg-teal-600 hover:bg-cyan-700 dark:hover:bg-teal-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            <span v-if="isSaving">Saving…</span>
            <span v-else>Save Settings</span>
          </button>
          <button @click="cancelEditing" :disabled="isSaving"
            class="px-4 py-2 text-sm rounded-lg bg-background-mute dark:bg-background/30 hover:bg-stroke-subtle dark:hover:bg-stroke/10 text-content-secondary dark:text-content-muted border border-stroke-subtle dark:border-stroke/20 transition-colors disabled:opacity-50">
            Cancel
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>
.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
