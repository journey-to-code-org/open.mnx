import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#root');
Object.assign(window, { ready: true });
