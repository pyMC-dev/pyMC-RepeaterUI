<script setup lang="ts">
/**
 * Stats Cards Component
 *
 * Displays the main dashboard statistics with sparkline visualizations.
 * Features:
 * - Rate-based sparkline data (packets per time bucket, not cumulative)
 * - Historical data initialization for immediate meaningful charts
 * - Smooth interpolation for real-time updates
 */
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from 'vue';
import ChartSparkline from './ChartSparkline.vue';
import { usePacketStore } from '@/stores/packets';
import { useWebSocketStore } from '@/stores/websocket';
import { useManagedPolling } from '@/composables/useManagedPolling';

defineOptions({ name: 'StatsCards' });

const packetStore = usePacketStore();
const wsStore = useWebSocketStore();
const interpolationInterval = ref<number | null>(null);
const isUpdating = ref(false);

// Computed properties from the store
const stats = computed(() => {
  const packetStats = packetStore.packetStats;
  const systemStats = packetStore.systemStats;

  // Format uptime to be more readable
  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
      return `${days}d ${hours}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  };

  const total = packetStats?.total_packets || 0;
  const dropped = packetStats?.dropped_packets || 0;
  const dropPercent = total > 0 ? Math.round((dropped / total) * 100) : 0;

  return {
    packetsReceived: total,
    packetsForwarded: packetStats?.transmitted_packets || 0,
    uptimeFormatted: systemStats ? formatUptime(systemStats.uptime_seconds || 0) : '0m',
    uptimeHours: systemStats ? Math.floor((systemStats.uptime_seconds || 0) / 3600) : 0,
    droppedPackets: dropped,
    dropPercent: `${dropPercent}%`,
    signalQuality: Math.round((packetStats?.avg_rssi || 0) + 120),
    crcErrorCount: packetStore.crcErrorCount,
  };
});

// Use rate-based sparkline data from store
const sparklineData = computed(() => {
  return packetStore.sparklineData;
});

const fetchStats = async () => {
  // Prevent concurrent updates
  if (isUpdating.value) return;

  try {
    isUpdating.value = true;
    // Use the packet store to fetch both system stats and packet stats
    await Promise.all([
      packetStore.fetchSystemStats(),
      packetStore.fetchPacketStats({ hours: 24 }),
    ]);

    // Batch DOM updates
    await nextTick();
  } catch (error) {
    console.error('Error fetching stats:', error);
  } finally {
    isUpdating.value = false;
  }
};

onMounted(async () => {
  // Initialize sparkline with historical data
  await packetStore.initializeSparklineHistory();

  // Then fetch current stats
  fetchStats();

  // Refresh sparkline data every 60 seconds (24-hour view doesn't need frequent updates)
  interpolationInterval.value = window.setInterval(() => {
    packetStore.interpolateRates();
  }, 60000);
});

useManagedPolling(fetchStats, {
  intervalMs: 30000,
  enabled: () => !wsStore.isConnected,
  immediate: false,
});

onBeforeUnmount(() => {
  if (interpolationInterval.value) {
    clearInterval(interpolationInterval.value);
  }
});
</script>

<template>
  <div
    class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 lg:gap-4 mb-5 stats-cards-container"
  >
    <!-- Up Time -->
    <ChartSparkline
      title="Up Time"
      :value="stats.uptimeFormatted"
      color="#EBA0FC"
      :data="[]"
      :showChart="false"
      class="stat-card"
    />

    <!-- RX Packets -->
    <ChartSparkline
      title="RX Packets"
      :value="stats.packetsReceived"
      color="#AAE8E8"
      :data="sparklineData.totalPackets"
      class="stat-card"
    />

    <!-- Forward -->
    <ChartSparkline
      title="Forward"
      :value="stats.packetsForwarded"
      color="#FFC246"
      :data="sparklineData.transmittedPackets"
      class="stat-card"
    />

    <!-- Dropped -->
    <ChartSparkline
      title="Dropped"
      :value="stats.droppedPackets"
      color="#FB787B"
      :data="sparklineData.droppedPackets"
      class="stat-card"
    />

    <!-- CRC Errors -->
    <ChartSparkline
      title="CRC Errors"
      :value="stats.crcErrorCount"
      color="#F59E0B"
      :data="sparklineData.crcErrors"
      class="stat-card"
    />
  </div>
</template>

<style scoped>
.stats-cards-container {
  /* Prevent layout shifts */
  will-change: auto;
  contain: layout;
}

.stat-card {
  /* Smooth transitions for value changes */
  transition: opacity 0.3s ease-out;
}

/* Prevent flash of content */
.stat-card :deep(.text-lg),
.stat-card :deep(.text-\[30px\]) {
  transition: color 0.2s ease-out;
}
</style>
