<script lang="ts">
  import { forgetEntry, listEntries, loadDraft, saveDraft, type Entry } from '../lib/history';

  let entries = $state(listEntries());
  let draft = $state(loadDraft());

  function forget(entry: Entry) {
    const warning = entry.token
      ? `Forget “${entry.title}”? You lose edit access on this device unless you saved the host link.`
      : `Remove “${entry.title}” from your list?`;
    if (!confirm(warning)) return;
    forgetEntry(entry.id);
    entries = entries.filter((e) => e.id !== entry.id);
  }

  function discardDraft() {
    saveDraft(undefined);
    draft = undefined;
  }

  const ago = (ms: number) => new Date(ms).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
</script>

<main class="stack">
  <section class="hero">
    <img class="logo" src="/icons/icon.svg" alt="" width="88" height="88" />
    <h1>Tallyup</h1>
    <p class="tagline">Split the bill. Share one link.<br />No app, no sign-up.</p>
    <a class="btn btn-primary cta" href="#/new">{draft ? 'Continue your draft' : 'Start a split'} →</a>
    {#if draft}<button class="btn btn-small" onclick={discardDraft}>Discard draft</button>{/if}
  </section>

  {#if entries.length}
    <section class="card stack">
      <h2>Your events</h2>
      {#each entries as e (e.id)}
        <div class="entry">
          <a href={e.token ? `#/h/${e.id}` : `#/s/${e.id}/${e.key}`}>
            <strong>{e.title}</strong>
            <span class="muted small">{e.token ? 'Hosting' : 'Shared with you'} · {ago(e.savedAt)}</span>
          </a>
          <button class="btn btn-icon" aria-label="Forget {e.title}" onclick={() => forget(e)}>✕</button>
        </div>
      {/each}
      <p class="muted small">Saved on this device only. Add Tallyup to your Home Screen so your browser keeps this list.</p>
    </section>
  {/if}

  <section class="steps">
    <div class="card step" style="--tilt: -1.5deg">
      <span class="emoji">📸</span>
      <div><strong>Snap the receipt</strong><br /><span class="muted small">Read on your phone. The photo is never uploaded.</span></div>
    </div>
    <div class="card step" style="--tilt: 1deg">
      <span class="emoji">👆</span>
      <div><strong>Tap who had what</strong><br /><span class="muted small">Tax and service are split by what each person ordered.</span></div>
    </div>
    <div class="card step" style="--tilt: -0.5deg">
      <span class="emoji">🔗</span>
      <div><strong>Send one link</strong><br /><span class="muted small">Friends see what they owe, where to transfer, and tap “I've paid”.</span></div>
    </div>
  </section>

  <p class="muted small center">
    🔒 Events are encrypted on your device before they are saved. Our server can't read them. Links expire 30 days
    after the last edit.
  </p>
</main>

<style>
  .hero {
    display: grid;
    justify-items: center;
    gap: 12px;
    padding: 32px 0 8px;
    text-align: center;
  }

  .logo {
    filter: drop-shadow(4px 4px 0 var(--line));
    animation: bob 2.4s ease-in-out infinite;
  }

  h1 {
    font-size: clamp(3rem, 14vw, 4.6rem);
    font-weight: 800;
    color: var(--accent);
    text-shadow: 3px 3px 0 var(--line);
  }

  .tagline {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 600;
  }

  .cta {
    min-height: 58px;
    padding: 12px 28px;
    font-size: 1.2rem;
  }

  .entry {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
    border-bottom: 2px dashed color-mix(in srgb, var(--ink) 15%, transparent);
  }

  .entry a {
    display: grid;
    text-decoration: none;
  }

  .steps {
    display: grid;
    gap: 14px;
  }

  .step {
    display: flex;
    align-items: center;
    gap: 14px;
    transform: rotate(var(--tilt));
  }

  .emoji {
    font-size: 2rem;
  }

  .center {
    text-align: center;
  }

  @keyframes bob {
    50% {
      transform: translateY(-8px) rotate(-4deg);
    }
  }
</style>
