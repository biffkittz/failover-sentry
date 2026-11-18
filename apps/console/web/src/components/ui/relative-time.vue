<script setup lang="ts">
import { computed } from 'vue';
import { useNow } from '@/composables/use-now';
import { absoluteTime, relativeTime } from '@/utils/format';

const props = defineProps<{ iso: string | null | undefined }>();
const now = useNow();
const relative = computed(() => relativeTime(props.iso, now.value));
</script>

<template>
  <time v-if="iso" :datetime="iso" :title="absoluteTime(iso)">{{ relative }}</time>
  <span v-else>never</span>
</template>
