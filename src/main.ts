import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import OverviewPage from "./pages/OverviewPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import SessionsPage from "./pages/SessionsPage.vue";
import "./styles/main.css";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: OverviewPage },
    { path: "/settings", component: SettingsPage },
    { path: "/sessions", component: SessionsPage },
  ],
});

createApp(App).use(createPinia()).use(router).mount("#app");
