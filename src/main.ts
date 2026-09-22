import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import "./styles/main.css";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: () => import("./pages/OverviewPage.vue") },
    { path: "/settings", component: () => import("./pages/SettingsPage.vue") },
    { path: "/sessions", component: () => import("./pages/SessionsPage.vue") },
  ],
});

createApp(App).use(createPinia()).use(router).mount("#app");
