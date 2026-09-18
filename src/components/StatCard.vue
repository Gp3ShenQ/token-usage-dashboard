<script setup lang="ts">
defineProps<{
  title: string;
  value: string;
  subValue?: string;
  tone?: "neutral" | "claude" | "codex";
}>();
</script>

<template>
  <article class="stat-card" :data-tone="tone ?? 'neutral'">
    <p class="stat-label">{{ title }}</p>
    <strong>{{ value }}</strong>
    <small v-if="subValue">{{ subValue }}</small>
  </article>
</template>
