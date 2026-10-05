import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

mount(App, { target: document.getElementById('app')! });

// Production only: a dev-server service worker would cache modules that HMR
// is trying to replace.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
