import { computed, onBeforeUnmount, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useAppRuntimeStore } from '@/stores/appRuntime';

interface ManagedPollingOptions {
  intervalMs: number;
  enabled?: MaybeRefOrGetter<boolean>;
  immediate?: boolean;
}

export function useManagedPolling(
  callback: () => unknown | Promise<unknown>,
  options: ManagedPollingOptions,
) {
  const appRuntime = useAppRuntimeStore();
  let intervalId: number | null = null;
  let runningPromise: Promise<unknown> | null = null;

  const isEnabled = computed(() => {
    const enabled = options.enabled === undefined ? true : toValue(options.enabled);
    return enabled && appRuntime.canMaintainConnections;
  });

  const runNow = async () => {
    if (runningPromise) {
      return runningPromise;
    }

    runningPromise = Promise.resolve(callback()).finally(() => {
      runningPromise = null;
    });

    return runningPromise;
  };

  const stop = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const start = async () => {
    stop();

    if (!isEnabled.value) {
      return;
    }

    if (options.immediate !== false) {
      await runNow();
    }

    intervalId = window.setInterval(() => {
      void runNow();
    }, options.intervalMs);
  };

  watch(
    isEnabled,
    (enabled) => {
      if (enabled) {
        void start();
      } else {
        stop();
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    stop();
  });

  return {
    start,
    stop,
    runNow,
  };
}