import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { installErrorReporting } from './plugins/error-reporting';
import { persistPlugin } from './plugins/pinia-persist';
import { createAppRouter } from './router';
import './styles/base.css';

const app = createApp(App);

const pinia = createPinia();
pinia.use(persistPlugin);
app.use(pinia);

const router = createAppRouter();
app.use(router);

app.use(VueQueryPlugin, {
  queryClient: new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 2 },
      mutations: { retry: 0 },
    },
  }),
});

installErrorReporting(app, router);

void router.isReady().then(() => app.mount('#app'));
