<script setup lang="ts">
import AppSidebar from "./components/AppSidebar.vue";
</script>

<template>
  <div class="shell">
    <AppSidebar />
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>
