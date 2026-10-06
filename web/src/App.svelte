<script lang="ts">
  import { fly } from 'svelte/transition';
  import { getEntry, saveEntry } from './lib/history';
  import { parseRoute } from './lib/links';
  import { toasts } from './lib/ui.svelte';
  import Editor from './views/Editor.svelte';
  import Home from './views/Home.svelte';
  import Viewer from './views/Viewer.svelte';

  let route = $state(parseRoute(location.hash));
  // A changing number, not the route itself, so going "home" twice still remounts.
  let visit = $state(0);

  function sync() {
    let next = parseRoute(location.hash);
    if (next.name === 'import') {
      // A host link: keep its credentials on this device, then take the edit
      // token out of the address bar where it could be screenshotted.
      const title = getEntry(next.id)?.title ?? 'Imported event';
      saveEntry({ id: next.id, key: next.key, token: next.token, title });
      history.replaceState(null, '', `#/h/${next.id}`);
      next = { name: 'host', id: next.id };
    }
    route = next;
    visit += 1;
    scrollTo({ top: 0 });
  }

  sync();
</script>

<svelte:window onhashchange={sync} />

{#key visit}
  {#if route.name === 'new'}
    <Editor id={undefined} />
  {:else if route.name === 'host'}
    <Editor id={route.id} />
  {:else if route.name === 'view'}
    <Viewer id={route.id} key={route.key} />
  {:else}
    <Home />
  {/if}
{/key}

<div class="toasts" aria-live="polite">
  {#each toasts as t (t.id)}
    <div class="toast" class:error={t.tone === 'error'} transition:fly={{ y: 20, duration: 180 }}>{t.text}</div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    inset: calc(16px + env(safe-area-inset-top)) 16px auto;
    z-index: 50;
    display: grid;
    justify-items: center;
    gap: 8px;
    pointer-events: none;
  }
  .toast {
    max-width: 560px;
    padding: 10px 16px;
    font-weight: 700;
    color: #1d1a2f;
    background: var(--mint);
    border: 2.5px solid #1d1a2f;
    border-radius: 999px;
    box-shadow: 3px 3px 0 #1d1a2f;
  }
  .toast.error {
    background: #ffb3b3;
  }
</style>
