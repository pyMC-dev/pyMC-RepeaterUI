import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useAppRuntimeStore } from '@/stores/appRuntime';
import { useWebSocketStore } from '@/stores/websocket';

export function useConnectionLifecycle() {
  const appRuntime = useAppRuntimeStore();
  const websocketStore = useWebSocketStore();

  const handleVisibilityChange = () => {
    const isVisible = document.visibilityState === 'visible';
    appRuntime.setDocumentVisible(isVisible);
  };

  const handleOnline = () => {
    appRuntime.setOnline(true);
  };

  const handleOffline = () => {
    appRuntime.setOnline(false);
  };

  onMounted(() => {
    appRuntime.syncAuthState();
    handleVisibilityChange();
    handleOnline();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  });

  watch(
    () => appRuntime.canMaintainConnections,
    (canMaintainConnections) => {
      if (canMaintainConnections) {
        websocketStore.allowReconnect();
        websocketStore.connect();
      } else if (!appRuntime.isOnline) {
        websocketStore.pause('offline');
      } else if (!appRuntime.isDocumentVisible) {
        websocketStore.pause('hidden');
      } else {
        websocketStore.pause('lifecycle');
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  });
}