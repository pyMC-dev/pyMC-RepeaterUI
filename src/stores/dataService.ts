import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useSystemStore } from './system';
import { usePacketStore } from './packets';
import { useNeighborStore } from './neighbors';
import ApiService from '@/utils/api';

type DataKey = 'stats' | 'packetStats' | 'noiseFloor' | 'recentPackets' | 'sparklines' | 'advertTier' | 'neighbors';

const TTL: Record<DataKey, number> = {
  stats: 30_000,
  packetStats: 60_000,
  noiseFloor: 60_000,
  recentPackets: 30_000,
  sparklines: 300_000,
  advertTier: 60_000,
  neighbors: 10 * 60_000,
};

export const useDataService = defineStore('dataService', () => {
  const systemStore = useSystemStore();
  const packetStore = usePacketStore();
  const neighborStore = useNeighborStore();

  const advertTier = ref({
    currentTier: 'unknown' as string,
    advertsAllowed: 0,
    advertsDropped: 0,
    activePenalties: 0,
  });

  const _lastFetch = new Map<DataKey, number>();
  const _inFlight = new Map<DataKey, Promise<void>>();
  let _pollHandles: number[] = [];
  let _bootstrapped = false;

  async function _withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
    throw new Error('unreachable');
  }

  async function _fetchAdvertTier(): Promise<void> {
    try {
      const response = await ApiService.get('/advert_rate_limit_stats');
      const data = response?.data as any;
      advertTier.value = {
        currentTier:
          typeof data?.adaptive?.current_tier === 'string'
            ? data.adaptive.current_tier
            : 'unknown',
        advertsAllowed: data?.stats?.adverts_allowed || 0,
        advertsDropped: data?.stats?.adverts_dropped || 0,
        activePenalties: Object.keys(data?.active_penalties || {}).length,
      };
      _lastFetch.set('advertTier', Date.now());
    } catch {
      // Non-critical — leave existing value
    }
  }

  async function ensure(key: DataKey): Promise<void> {
    // Neighbors uses its own lastFetched for TTL (so user-triggered fetches are respected)
    if (key === 'neighbors') {
      if (!neighborStore.isStale()) return;
    } else {
      const lastFetch = _lastFetch.get(key);
      if (lastFetch !== undefined && Date.now() - lastFetch < TTL[key]) return;
    }

    const existing = _inFlight.get(key);
    if (existing) return existing;

    let promise: Promise<void>;

    switch (key) {
      case 'stats':
        promise = systemStore.fetchStats().then(() => {
          _lastFetch.set('stats', Date.now());
        });
        break;
      case 'packetStats':
        promise = packetStore.fetchPacketStats({ hours: 24 }).then(() => {
          _lastFetch.set('packetStats', Date.now());
        });
        break;
      case 'noiseFloor':
        promise = packetStore.fetchNoiseFloorHistory({ hours: 24 }).then(() => {
          _lastFetch.set('noiseFloor', Date.now());
        });
        break;
      case 'recentPackets':
        promise = packetStore.fetchRecentPackets({ limit: 100 }).then(() => {
          _lastFetch.set('recentPackets', Date.now());
        });
        break;
      case 'sparklines':
        promise = packetStore.initializeSparklineHistory().then(() => {
          _lastFetch.set('sparklines', Date.now());
        });
        break;
      case 'advertTier':
        promise = _fetchAdvertTier();
        break;
      case 'neighbors':
        promise = neighborStore.fetchAll(neighborStore.currentHours).then(() => {});
        break;
    }

    _inFlight.set(key, promise!);
    promise!.finally(() => _inFlight.delete(key));
    return promise!;
  }

  async function bootstrap(): Promise<void> {
    if (_bootstrapped) return;
    _bootstrapped = true;

    // Phase 1: Critical — stats with retry (needed for config, node name, public key)
    try {
      await _withRetry(() => systemStore.fetchStats());
      _lastFetch.set('stats', Date.now());
    } catch {
      console.error('[DataService] Failed to fetch stats after retries');
    }

    // Phase 2: Secondary — packet data in parallel (non-blocking)
    void Promise.allSettled([
      packetStore.fetchPacketStats({ hours: 24 }).then(() => _lastFetch.set('packetStats', Date.now())),
      packetStore.fetchNoiseFloorHistory({ hours: 24 }).then(() => _lastFetch.set('noiseFloor', Date.now())),
      packetStore.fetchRecentPackets({ limit: 100 }).then(() => _lastFetch.set('recentPackets', Date.now())),
    ]);

    // Phase 3: Background — fire and forget
    void ensure('advertTier');
    void ensure('sparklines');
    void ensure('neighbors');

    _startPolling();
  }

  function _startPolling(): void {
    stopPolling();

    // AdvertTier every 30s — WS never pushes this data
    _pollHandles.push(window.setInterval(() => void ensure('advertTier'), 30_000));

    // PacketStats every 60s — WS pushes some fields but not all
    _pollHandles.push(window.setInterval(() => void ensure('packetStats'), 60_000));

    // Sparklines every 5 minutes
    _pollHandles.push(window.setInterval(() => void ensure('sparklines'), 300_000));

    // Stats every 30s — only when not recently updated by WS
    _pollHandles.push(
      window.setInterval(() => {
        const lastUpdate = systemStore.lastUpdated?.getTime() ?? 0;
        if (Date.now() - lastUpdate > 25_000) {
          void ensure('stats');
        }
      }, 30_000),
    );
  }

  // Called by websocket on reconnect — refreshes critical data after 3s delay
  async function onReconnect(): Promise<void> {
    await new Promise((r) => setTimeout(r, 3000));
    await Promise.allSettled([
      ensure('stats'),
      ensure('packetStats'),
      ensure('recentPackets'),
    ]);
  }

  function stopPolling(): void {
    for (const h of _pollHandles) clearInterval(h);
    _pollHandles = [];
  }

  function reset(): void {
    stopPolling();
    _bootstrapped = false;
    _lastFetch.clear();
    _inFlight.clear();
    advertTier.value = {
      currentTier: 'unknown',
      advertsAllowed: 0,
      advertsDropped: 0,
      activePenalties: 0,
    };
  }

  return {
    advertTier,
    bootstrap,
    ensure,
    onReconnect,
    stopPolling,
    reset,
  };
});
