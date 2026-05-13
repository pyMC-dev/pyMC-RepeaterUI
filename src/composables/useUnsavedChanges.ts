import { ref, type Ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';

export function useUnsavedChanges(
  isEditing: Ref<boolean>,
  isSaving: Ref<boolean>,
  cancelFn: () => void,
  saveFn: () => Promise<boolean>,
) {
  const showUnsavedModal = ref(false);
  const pendingNavFn = ref<(() => void) | null>(null);

  onBeforeRouteLeave((_to, _from, next) => {
    if (isEditing.value) {
      showUnsavedModal.value = true;
      pendingNavFn.value = () => next();
    } else {
      next();
    }
  });

  function requestLeave(callback: () => void) {
    if (isEditing.value) {
      showUnsavedModal.value = true;
      pendingNavFn.value = callback;
    } else {
      callback();
    }
  }

  function handleDiscard() {
    cancelFn();
    showUnsavedModal.value = false;
    if (pendingNavFn.value) { pendingNavFn.value(); pendingNavFn.value = null; }
  }

  async function handleSave() {
    const ok = await saveFn();
    if (ok) {
      showUnsavedModal.value = false;
      if (pendingNavFn.value) { pendingNavFn.value(); pendingNavFn.value = null; }
    }
  }

  return { showUnsavedModal, requestLeave, handleDiscard, handleSave };
}
