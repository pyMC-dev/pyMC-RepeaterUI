<script setup lang="ts">
withDefaults(defineProps<{
  /**
   * sm  — 20px / border-2  — inline button or tight loading state
   * md  — 32px / border-[3px] — card or section loading state
   * lg  — 64px / border-4  — full-screen overlay (replaces bar spinner)
   */
  size?: 'sm' | 'md' | 'lg';
}>(), {
  size: 'md',
});
</script>

<template>
  <div
    class="rounded-full animate-spin border-primary border-t-transparent"
    :class="{
      'w-5 h-5 border-2':      size === 'sm',
      'w-8 h-8 border-[3px]':  size === 'md',
      'w-16 h-16 border-4':    size === 'lg',
    }"
  />
</template>
