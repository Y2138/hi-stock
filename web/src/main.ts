// web 工程入口
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { initTheme } from "./stores/theme";
import "@vueform/multiselect/themes/default.css";
import "./theme.css";

initTheme();

createApp(App).use(router).mount("#app");
