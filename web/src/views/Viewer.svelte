<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Receipt from '../components/Receipt.svelte';
  import { loadClaims, loadEvent, sendClaim, type ClaimRow } from '../lib/api';
  import type { EventDoc } from '../lib/doc';
  import { getEntry, saveEntry } from '../lib/history';
  import { rp } from '../lib/money';
  import { summarize } from '../lib/split';
  import { colorAt, copyText, fail, initials, toast } from '../lib/ui.svelte';
  import type { Transfer } from 'debt-simplify';

  let { id, key }: { id: string; key: string } = $props();

  let doc = $state<EventDoc>();
  let expiresAt = $state<string>();
  let claims = $state<ClaimRow[]>([]);
  let error = $state('');
  // App remounts this view per route, so reading the first id is deliberate.
  let entry = $state(untrack(() => getEntry(id)));
  let me = $state(untrack(() => entry?.meId));
  let sending = $state(false);
  let printId = $state(0);

  const summary = $derived(doc ? summarize(doc) : undefined);
  const person = (pid: string) => doc?.people.find((p) => p.id === pid);
  const nameOf = (pid: string) => person(pid)?.name ?? '?';
  const owes = $derived(summary && me ? summary.transfers.filter((t) => t.from === me) : []);
  const owed = $derived(summary && me ? summary.transfers.filter((t) => t.to === me) : []);

  onMount(async () => {
    try {
      const loaded = await loadEvent(id, key);
      doc = loaded.doc;
      expiresAt = loaded.expiresAt;
      if (me && !doc.people.some((p) => p.id === me)) me = undefined;
      entry = saveEntry({ id, key, title: doc.title });
      claims = await loadClaims(id, key);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not open this link.';
    }
  });

  function choose(pid: string | undefined) {
    me = pid;
    entry = saveEntry({ id, meId: pid });
  }

  const pending = (t: Transfer) => claims.some((c) => c.from === t.from && c.to === t.to && c.amount === t.amount);

  async function claim(t: Transfer) {
    sending = true;
    try {
      const at = Date.now();
      const { id: claimId } = await sendClaim(id, key, { from: t.from, to: t.to, amount: t.amount, at });
      claims = [...claims, { ...t, at, claimId }];
      toast(`Sent! ${nameOf(t.to)} will see it once the host confirms.`);
    } catch (e) {
      fail(e);
    } finally {
      sending = false;
    }
  }
</script>

<main class="stack">
  <header class="spread">
    <a class="btn btn-small" href="#/">← Tallyup</a>
    {#if entry?.token}<a class="btn btn-small btn-sun" href="#/h/{id}">✏️ Edit</a>{/if}
  </header>

  {#if error}
    <div class="notice error">{error}</div>
    <p class="muted">Links stop working 30 days after the host's last edit, or when the host resets or deletes the event.</p>
  {:else if !doc || !summary}
    <div class="loading card">
      <span class="spin">🧾</span> Unlocking the receipt…
    </div>
  {:else}
    <section class="card stack you">
      {#if !me}
        <h2>Which one are you?</h2>
        <div class="row">
          {#each doc.people as p, i (p.id)}
            <button class="chip" style="--c: {colorAt(i)}" onclick={() => choose(p.id)}>
              <span class="avatar" style="--c: {colorAt(i)}">{initials(p.name)}</span>{p.name}
            </button>
          {/each}
        </div>
      {:else}
        <div class="spread">
          <h2>Hi, {nameOf(me)}!</h2>
          <button class="btn btn-small" onclick={() => choose(undefined)}>Not you?</button>
        </div>

        {#each owes as t (t.to)}
          {@const to = person(t.to)}
          <div class="pay-card stack">
            <div class="spread">
              <span>You pay <strong>{nameOf(t.to)}</strong></span>
              <span class="big">{rp(t.amount)}</span>
            </div>
            {#if to?.payment}
              <div class="bank">
                <div class="label">{to.payment.bankName}</div>
                <div class="spread">
                  <span class="acct">{to.payment.accountNumber}</span>
                  <button class="btn btn-small" onclick={() => to.payment && copyText(to.payment.accountNumber, 'Account number copied')}>Copy</button>
                </div>
                {#if to.payment.accountHolder}<div class="muted small">a.n. {to.payment.accountHolder}</div>{/if}
              </div>
            {:else}
              <p class="muted small">Ask {nameOf(t.to)} how they'd like to be paid.</p>
            {/if}
            {#if pending(t)}
              <div class="notice">⏳ Waiting for the host to confirm your payment.</div>
            {:else}
              <button class="btn btn-mint btn-block" disabled={sending} onclick={() => claim(t)}>I've paid {rp(t.amount)}</button>
            {/if}
          </div>
        {/each}

        {#each owed as t (t.from)}
          <div class="owed spread">
            <span><strong>{nameOf(t.from)}</strong> pays you</span>
            <span class="big">{rp(t.amount)}</span>
          </div>
        {/each}

        {#if owes.length === 0 && owed.length === 0}
          <p class="square">{summary.grandTotal > 0 ? "You're all square 🎉" : 'No bills yet. Check back soon.'}</p>
        {/if}
      {/if}
    </section>

    {#key printId}
      <Receipt {doc} {summary} {expiresAt} highlight={me} />
    {/key}
    <button class="btn btn-small reprint" onclick={() => (printId += 1)}>↻ Print again</button>

    <a class="btn btn-block" href="#/new">Split your own bill →</a>
  {/if}
</main>

<style>
  .loading {
    text-align: center;
    font-weight: 700;
  }

  .spin {
    display: inline-block;
    animation: wiggle 0.5s ease-in-out infinite alternate;
  }

  .reprint {
    justify-self: center;
  }

  .you {
    background: color-mix(in srgb, var(--sun) 25%, var(--surface));
  }

  .pay-card {
    padding: 14px;
    background: var(--surface);
    border: 2.5px solid var(--line);
    border-radius: 12px;
  }

  .bank {
    padding: 10px 12px;
    background: color-mix(in srgb, var(--blue) 10%, var(--surface));
    border: 2px dashed var(--line);
    border-radius: 10px;
  }

  .acct {
    font: 700 1.15rem var(--mono);
    letter-spacing: 0.05em;
    overflow-wrap: anywhere;
  }

  .big {
    font: 700 1.2rem var(--mono);
    white-space: nowrap;
  }

  .owed {
    padding: 10px 14px;
    border: 2px dashed var(--line);
    border-radius: 12px;
  }

  .square {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 800;
    text-align: center;
  }

  @keyframes wiggle {
    to {
      transform: rotate(-12deg);
    }
  }
</style>
