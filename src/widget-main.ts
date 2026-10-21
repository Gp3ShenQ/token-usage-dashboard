import { createApp } from "vue";
import WidgetApp from "./widget/WidgetApp.vue";
import MascotApp from "./widget/MascotApp.vue";
import "./styles/main.css";

const view = new URLSearchParams(window.location.search).get("view");
createApp(view === "mascot" ? MascotApp : WidgetApp).mount("#widget-app");
