<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { slide } from 'svelte/transition';
  import BillCard from '../components/BillCard.svelte';
  import Receipt from '../components/Receipt.svelte';
  import { ApiError, createEvent, deleteClaim, deleteEvent, loadEvent, updateEvent, type ClaimRow } from '../lib/api';
  import { newKey } from '../lib/crypto';
  import { LIMITS, localId, newBill, newDoc, parseDoc, problemOf, type EventDoc, type Person } from '../lib/doc';
  import { forgetEntry, getEntry, loadDraft, requestPersistence, saveDraft, saveEntry, type Entry } from '../lib/history';
  import { go, hostLink, viewLink } from '../lib/links';
  import { rp } from '../lib/money';
  import { summarize } from '../lib/split';
  import { colorAt, copyText, fail, initials, shareUrl, toast } from '../lib/ui.svelte';

  /** Undefined for a new draft; a share id to edit a published event. */
  let { id: idProp }: { id: string | undefined } = $props();
  // App remounts this view on every route change, so the first id is the only one it sees.
  const id = untrack(() => idProp);

  let doc = $state<EventDoc>(id ? newDoc() : (loadDraft() ?? newDoc()));
  let entry = $state<Entry | undefined>(id ? getEntry(id) : undefined);
  let version = $state(0);
  let expiresAt = $state<string>();
  let claims = $state<ClaimRow[]>([]);
  let loading = $state(Boolean(id));
  let loadError = $state('');
  let busy = $state(false);
  let selected = $state<string>();
  let newName = $state('');
  let sheet = $state<HTMLDialogElement>();
  let printId = $state(0);

  const summary = $derived.by(() => {
    try {
      return summarize(doc);
    } catch {
      return undefined;
    }
  });
  const live = $derived(Boolean(entry?.token));
  const nameOf = (pid: string) => doc.people.find((p) => p.id === pid)?.name ?? '?';
  const colorOf = (pid: string) => colorAt(doc.people.findIndex((p) => p.id === pid));

  onMount(async () => {
    if (!id) return;
    if (!entry?.token) {
      loadError = "This device doesn't have edit access to that event. Open the host link to edit it.";
      loading = false;
      return;
    }
    try {
      const loaded = await loadEvent(id, entry.key);
      doc = loaded.doc;
      version = loaded.version;
      expiresAt = loaded.expiresAt;
      claims = loaded.claims;
      entry = saveEntry({ id, title: doc.title });
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Could not load this event.';
    }
    loading = false;
  });

  // An unpublished draft survives a reload or a closed tab.
  $effect(() => {
    if (!entry?.token) saveDraft($state.snapshot(doc));
  });

  /** Fetch new claims only. The document on screen may hold unsaved edits, so it is left alone. */
  async function refreshClaims() {
    if (!entry) return;
    try {
      claims = (await loadEvent(entry.id, entry.key)).claims;
      if (claims.length === 0) toast('No new payments yet');
    } catch (error) {
      fail(error);
    }
  }

  /** Validate, encrypt and upload. Creates the share on first save. */
  async function persist(): Promise<boolean> {
    if (!doc.title.trim()) doc.title = `Split ${new Date().toLocaleDateString('id-ID')}`;
    let plain: EventDoc;
    try {
      plain = parseDoc($state.snapshot(doc));
    } catch (error) {
      toast(problemOf(error), 'error');
      return false;
    }

    busy = true;
    try {
      if (!entry?.token) {
        const key = newKey();
        const created = await createEvent(key, plain);
        entry = saveEntry({ id: created.id, key, token: created.editToken, title: plain.title, meId: plain.people[0].id });
        version = created.version;
        expiresAt = created.expiresAt;
        saveDraft(undefined);
        // Stay on this screen; a reload now lands on the host route.
        history.replaceState(null, '', `#/h/${created.id}`);
        requestPersistence();
      } else {
        const updated = await updateEvent(entry.id, entry.key, entry.token, plain, version);
        version = updated.version;
        expiresAt = updated.expiresAt;
        entry = saveEntry({ id: entry.id, title: plain.title });
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        toast('This event changed on another device. Reloading…', 'error');
        setTimeout(() => location.reload(), 1500);
      } else {
        fail(error);
      }
      return false;
    } finally {
      busy = false;
    }
  }

  async function print() {
    if (await persist()) {
      printId += 1;
      sheet?.showModal();
      // Opening focuses the first button, which can scroll the printer out of view.
      sheet?.scrollTo({ top: 0 });
    }
  }

  function addPerson(event: SubmitEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (doc.people.length >= LIMITS.people) return toast(`Up to ${LIMITS.people} people per event`, 'error');
    doc.people.push({ id: localId(), name: name.slice(0, LIMITS.name) });
    newName = '';
  }

  function removePerson(pid: string) {
    if (doc.people.length === 1) return;
    if (!confirm(`Remove ${nameOf(pid)}? Their items go back to everyone, and their payments are dropped.`)) return;
    doc.people = doc.people.filter((p) => p.id !== pid);
    const fallback = doc.people[0].id;
    for (const bill of doc.bills) {
      if (bill.paidBy === pid) bill.paidBy = fallback;
      for (const item of bill.items) item.for = item.for.filter((x) => x !== pid);
    }
    doc.settlements = doc.settlements.filter((s) => s.from !== pid && s.to !== pid);
    selected = undefined;
  }

  function togglePayment(person: Person, on: boolean) {
    person.payment = on ? { bankName: '', accountNumber: '', accountHolder: '' } : undefined;
  }

  function removeBill(index: number) {
    if (doc.bills[index].items.length && !confirm(`Remove “${doc.bills[index].name}”?`)) return;
    doc.bills.splice(index, 1);
  }

  async function markPaid(from: string, to: string, amount: number, claim?: ClaimRow) {
    doc.settlements.push({ id: localId(), from, to, amount, at: Date.now() });
    if (!(await persist())) {
      doc.settlements.pop();
      return;
    }
    if (claim) await dismissClaim(claim);
    toast(`${nameOf(from)} → ${nameOf(to)} marked paid`);
  }

  async function dismissClaim(claim: ClaimRow) {
    if (!entry?.token) return;
    try {
      await deleteClaim(entry.id, entry.token, claim.claimId);
      claims = claims.filter((c) => c.claimId !== claim.claimId);
    } catch (error) {
      fail(error);
    }
  }

  async function undoPayment(sid: string) {
    const before = doc.settlements;
    doc.settlements = doc.settlements.filter((s) => s.id !== sid);
    if (!(await persist())) doc.settlements = before;
  }

  async function resetLink() {
    if (!entry?.token) return;
    if (!confirm('Make a new share link? The old link stops working for everyone, and unanswered payment claims are cleared.')) return;
    busy = true;
    try {
      const key = newKey();
      const updated = await updateEvent(entry.id, key, entry.token, parseDoc($state.snapshot(doc)), version);
      version = updated.version;
      const { id: shareId, token } = entry;
      await Promise.all(claims.map((c) => deleteClaim(shareId, token, c.claimId)));
      claims = [];
      entry = saveEntry({ id: shareId, key });
      toast('New link ready. Share it again.');
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!entry?.token || !confirm(`Delete “${doc.title}” for everyone? This cannot be undone.`)) return;
    try {
      await deleteEvent(entry.id, entry.token);
      forgetEntry(entry.id);
      toast('Event deleted');
      go('#/');
    } catch (error) {
      fail(error);
    }
  }

  function startOver() {
    if (!confirm('Throw away this draft?')) return;
    doc = newDoc();
  }
</script>

<main class="stack">
  <header class="spread">
    <a class="btn btn-small" href="#/">← Home</a>
    {#if live}
      <span class="badge live">● Live</span>
    {:else}
      <span class="badge">Draft</span>
    {/if}
  </header>

  {#if loading}
    <div class="card">Unlocking your event…</div>
  {:else if loadError}
    <div class="notice error">{loadError}</div>
  {:else}
    <section class="card stack">
      <label class="label" for="title">What's this split for?</label>
      <input id="title" class="title-input" bind:value={doc.title} maxlength={LIMITS.title} placeholder="Friday dinner at Bu Tini's" />
    </section>

    <section class="card stack">
      <div class="spread">
        <h2>Who's in?</h2>
        <span class="muted small">{doc.people.length}/{LIMITS.people} · tap to edit</span>
      </div>
      <div class="row">
        {#each doc.people as p, i (p.id)}
          <button class="chip" style="--c: {colorAt(i)}" aria-pressed={selected === p.id} onclick={() => (selected = selected === p.id ? undefined : p.id)}>
            <span class="avatar" style="--c: {colorAt(i)}">{initials(p.name)}</span>
            {p.name || '…'}{#if p.payment}<span aria-label="has bank details"> 🏦</span>{/if}
          </button>
        {/each}
      </div>

      {#each doc.people as p (p.id)}
        {#if selected === p.id}
          <div class="person stack" transition:slide={{ duration: 180 }}>
            <div class="field">
              <label class="label" for="name-{p.id}">Name</label>
              <input id="name-{p.id}" bind:value={p.name} maxlength={LIMITS.name} />
            </div>
            <label class="row">
              <input type="checkbox" checked={Boolean(p.payment)} onchange={(e) => togglePayment(p, e.currentTarget.checked)} />
              <span>Show bank details so people can pay {p.name || 'them'}</span>
            </label>
            {#if p.payment}
              <div class="bank stack" transition:slide={{ duration: 150 }}>
                <div class="field">
                  <label class="label" for="bank-{p.id}">Bank</label>
                  <input id="bank-{p.id}" bind:value={p.payment.bankName} maxlength="40" placeholder="BCA, Mandiri, BRI…" />
                </div>
                <div class="field">
                  <label class="label" for="acct-{p.id}">Account number</label>
                  <input
                    id="acct-{p.id}"
                    inputmode="numeric"
                    autocomplete="off"
                    value={p.payment.accountNumber}
                    oninput={(e) => {
                      const digits = e.currentTarget.value.replace(/\D/g, '').slice(0, 24);
                      e.currentTarget.value = digits;
                      if (p.payment) p.payment.accountNumber = digits;
                    }}
                  />
                </div>
                <div class="field">
                  <label class="label" for="holder-{p.id}">Account holder <span class="muted">(optional)</span></label>
                  <input id="holder-{p.id}" bind:value={p.payment.accountHolder} maxlength="60" placeholder="Name on the account" />
                </div>
                <p class="muted small">Anyone with the share link can see these details.</p>
              </div>
            {/if}
            <div class="spread">
              <button class="btn btn-small btn-danger" disabled={doc.people.length === 1} onclick={() => removePerson(p.id)}>Remove</button>
              <button class="btn btn-small" onclick={() => (selected = undefined)}>Done</button>
            </div>
          </div>
        {/if}
      {/each}

      <form class="add" onsubmit={addPerson}>
        <input bind:value={newName} placeholder="Add a friend's name" aria-label="Friend's name" maxlength={LIMITS.name} />
        <button class="btn btn-sun">Add</button>
      </form>
    </section>

    {#each doc.bills as bill, i (bill.id)}
      <BillCard bind:bill={doc.bills[i]} people={doc.people} breakdown={summary?.bills[i]} onremove={() => removeBill(i)} />
    {/each}

    <button class="btn btn-block add-bill" onclick={() => doc.bills.push(newBill(doc.people[0].id, doc.bills.length + 1))} disabled={doc.bills.length >= LIMITS.bills}>
      ＋ Add a bill
    </button>

    {#if claims.length}
      <section class="card stack claims" transition:slide>
        <h2>🔔 Payment claims</h2>
        {#each claims as c (c.claimId)}
          <div class="claim stack">
            <div><strong>{nameOf(c.from)}</strong> says they paid <strong>{nameOf(c.to)}</strong> <span class="amount">{rp(c.amount)}</span></div>
            <div class="row">
              <button class="btn btn-small btn-mint" disabled={busy} onclick={() => markPaid(c.from, c.to, c.amount, c)}>Confirm</button>
              <button class="btn btn-small" disabled={busy} onclick={() => dismissClaim(c)}>Decline</button>
            </div>
          </div>
        {/each}
      </section>
    {/if}

    {#if summary && summary.grandTotal > 0}
      <section class="card stack">
        <div class="spread">
          <h2>Who owes what</h2>
          <span class="muted small">Total {rp(summary.grandTotal)}</span>
        </div>
        {#each summary.transfers as t (t.from + t.to)}
          <div class="transfer">
            <span class="avatar" style="--c: {colorOf(t.from)}">{initials(nameOf(t.from))}</span>
            <span class="who"><strong>{nameOf(t.from)}</strong> → {nameOf(t.to)}</span>
            <span class="amount">{rp(t.amount)}</span>
            {#if live}
              <button class="btn btn-small btn-mint" disabled={busy} onclick={() => markPaid(t.from, t.to, t.amount)}>Paid</button>
            {/if}
          </div>
        {:else}
          <p class="square">Everyone is square 🎉</p>
        {/each}
        {#if doc.settlements.length}
          <div class="label">Paid</div>
          {#each doc.settlements as s (s.id)}
            <div class="transfer done">
              <span class="avatar" style="--c: {colorOf(s.from)}">✓</span>
              <span class="who">{nameOf(s.from)} → {nameOf(s.to)}</span>
              <span class="amount">{rp(s.amount)}</span>
              <button class="btn btn-small" disabled={busy} onclick={() => undoPayment(s.id)}>Undo</button>
            </div>
          {/each}
        {/if}
        {#if !live}<p class="muted small">Print & share first; then you can mark payments here.</p>{/if}
      </section>
    {/if}

    {#if live && entry}
      <section class="card stack">
        <h2>Share</h2>
        <div class="row">
          <button class="btn btn-primary" onclick={() => entry && shareUrl(viewLink(entry.id, entry.key), doc.title)}>Send link</button>
          <button class="btn" onclick={refreshClaims}>Check for payments</button>
        </div>
        {#if expiresAt}
          <p class="muted small">The link expires {new Date(expiresAt).toLocaleDateString('id-ID', { dateStyle: 'long' })}, 30 days after your last save.</p>
        {/if}
        <details>
          <summary>Danger zone</summary>
          <div class="stack danger">
            <button class="btn btn-small" disabled={busy} onclick={resetLink}>Reset share link</button>
            <button class="btn btn-small btn-danger" disabled={busy} onclick={remove}>Delete event</button>
          </div>
        </details>
      </section>
    {:else}
      <button class="btn btn-small btn-danger start-over" onclick={startOver}>Start over</button>
    {/if}

    <div class="action-bar">
      <div>
        <button class="btn btn-primary" onclick={print} disabled={busy || !summary}>
          🧾 {busy ? 'Saving…' : live ? 'Save & reprint' : 'Print & share'}
        </button>
      </div>
    </div>

    <dialog bind:this={sheet}>
      <div class="sheet stack">
        {#if summary && entry}
          {#key printId}
            <Receipt {doc} {summary} {expiresAt} />
          {/key}
          <details class="host-link">
            <summary>Save your host link</summary>
            <p class="small">
              This one lets anyone <strong>edit</strong> the event. Keep it private, somewhere like your notes app, so you can edit
              from another phone or after clearing your browser.
            </p>
            <button class="btn btn-small" onclick={() => entry?.token && copyText(hostLink(entry.id, entry.key, entry.token), 'Host link copied. Keep it private!')}>
              Copy host link
            </button>
          </details>
        {/if}
        <div class="sheet-actions">
          {#if entry}
            <button class="btn btn-primary" onclick={() => entry && shareUrl(viewLink(entry.id, entry.key), doc.title)}>
              Send the link
            </button>
          {/if}
          <button class="btn" onclick={() => sheet?.close()}>Done</button>
        </div>
      </div>
    </dialog>
  {/if}
</main>

<style>
  .badge {
    padding: 4px 12px;
    font-weight: 800;
    font-size: 0.8rem;
    border: 2px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
  }

  .badge.live {
    background: var(--mint);
    color: #1d1a2f;
  }

  .person {
    padding: 12px;
    border: 2px dashed var(--line);
    border-radius: 12px;
  }

  .bank {
    padding-left: 30px;
  }

  .add {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
  }

  .add-bill {
    border-style: dashed;
    box-shadow: none;
    border-radius: var(--radius);
    min-height: 56px;
  }

  .transfer {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    align-items: center;
    gap: 10px;
  }

  .transfer.done {
    opacity: 0.7;
  }

  .who {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .amount {
    font-family: var(--mono);
    font-weight: 700;
    white-space: nowrap;
  }

  .square {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 800;
    text-align: center;
  }

  .claims {
    background: color-mix(in srgb, var(--sun) 30%, var(--surface));
    animation: nudge 0.6s ease-out;
  }

  .claim {
    padding-bottom: 10px;
    border-bottom: 2px dashed color-mix(in srgb, var(--ink) 20%, transparent);
  }

  .claim:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  details summary {
    cursor: pointer;
    font-weight: 700;
  }

  .danger {
    margin-top: 10px;
    justify-items: start;
  }

  .start-over {
    justify-self: center;
  }

  .sheet {
    padding: 16px;
  }

  .sheet-actions {
    position: sticky;
    bottom: 0;
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 10px;
    margin: 0 -16px -16px;
    padding: 24px 16px 16px;
    background: linear-gradient(transparent, var(--bg) 30%);
  }

  .host-link {
    padding: 10px 12px;
    border: 2px dashed var(--line);
    border-radius: 12px;
  }

  @keyframes nudge {
    30% {
      transform: rotate(-1.5deg);
    }
    60% {
      transform: rotate(1deg);
    }
  }
</style>
