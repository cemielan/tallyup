<script lang="ts">
  import confetti from 'canvas-confetti';
  import { onMount, untrack } from 'svelte';
  import type { EventDoc } from '../lib/doc';
  import { rupiah } from '../lib/money';
  import { lineTotal, type Summary } from '../lib/split';

  let {
    doc,
    summary,
    highlight,
    expiresAt,
  }: { doc: EventDoc; summary: Summary; highlight?: string; expiresAt?: string } = $props();

  const nameOf = (id: string) => doc.people.find((p) => p.id === id)?.name ?? '?';
  const forLabel = (ids: string[]) =>
    ids.length === 0 || ids.length === doc.people.length ? 'everyone' : ids.map(nameOf).join(', ');

  // People who are still owed money and said how to pay them.
  const payTo = $derived.by(() => {
    const owed = new Set(summary.transfers.map((t) => t.to));
    return doc.people.filter((p) => p.payment && owed.has(p.id));
  });

  // Paper length drives the print: longer receipts take longer, within reason.
  // Measured once: a reprint remounts this component.
  const lines = untrack(
    () =>
      12 +
      doc.people.length +
      summary.transfers.length +
      doc.settlements.length +
      summary.bills.reduce((n, b) => n + 6 + b.bill.items.length * 2, 0),
  );
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = reduced ? 0 : Math.min(4.2, Math.max(1.4, lines * 0.06));
  const steps = Math.max(12, Math.round(lines * 1.4));

  let printing = $state(!reduced);
  let canvas: HTMLCanvasElement;

  onMount(() => {
    const timer = setTimeout(() => {
      printing = false;
      if (summary.settled && !reduced) {
        // Own canvas, no worker: the default instance spawns a blob: worker,
        // which the CSP (worker-src 'self') forbids.
        confetti.create(canvas, { resize: true, useWorker: false })({
          particleCount: 140,
          spread: 80,
          origin: { y: 0.3 },
          colors: ['#ff5a36', '#ffc533', '#2fcf8a', '#2f6bff'],
        });
      }
    }, duration * 1000);
    return () => clearTimeout(timer);
  });

  const printedAt = new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<canvas class="confetti" bind:this={canvas} aria-hidden="true"></canvas>

<div class="receipt" style="--dur: {duration}s; --steps: {steps}">
  <div class="printer" class:printing aria-hidden="true">
    <span class="led"></span>
    <span>TALLYUP·PRINT</span>
    <span class="slot"></span>
  </div>

  <div class="feed">
    <article class="paper" aria-label="Receipt for {doc.title}">
      <header class="center">
        <div class="brand">TALLYUP</div>
        <h2>{doc.title}</h2>
        <div class="dim">{printedAt} · {doc.people.length} {doc.people.length === 1 ? 'person' : 'people'}</div>
      </header>

      {#each summary.bills as b (b.bill.id)}
        <hr />
        <div class="line strong"><span>{b.bill.name}</span><span class="dim">paid by {nameOf(b.bill.paidBy)}</span></div>
        {#each b.bill.items as item, i (i)}
          <div class="line">
            <span>{item.qty}x {item.name || 'Item'}</span><span>{rupiah(lineTotal(item))}</span>
          </div>
          <div class="who">↳ {forLabel(item.for)}</div>
        {/each}
        {#if b.bill.tax}<div class="line dim"><span>Tax</span><span>{rupiah(b.bill.tax)}</span></div>{/if}
        {#if b.bill.service}<div class="line dim"><span>Service</span><span>{rupiah(b.bill.service)}</span></div>{/if}
        {#if b.bill.discount}<div class="line dim"><span>Discount</span><span>-{rupiah(b.bill.discount)}</span></div>{/if}
        {#if b.error}
          <div class="who">⚠ {b.error} — not counted</div>
        {:else}
          <div class="line strong"><span>TOTAL</span><span>{rupiah(b.total)}</span></div>
        {/if}
      {/each}

      <hr class="double" />
      <div class="line big"><span>GRAND TOTAL</span><span>Rp {rupiah(summary.grandTotal)}</span></div>

      <hr />
      <div class="section">EACH PERSON</div>
      {#each doc.people as p (p.id)}
        <div class="line" class:me={p.id === highlight}>
          <span>{p.id === highlight ? '► ' : ''}{p.name}</span><span>{rupiah(summary.consumed[p.id] ?? 0)}</span>
        </div>
      {/each}

      <hr />
      <div class="section">SETTLE UP</div>
      {#each summary.transfers as t (t.from + t.to)}
        <div class="line" class:me={t.from === highlight || t.to === highlight}>
          <span>{nameOf(t.from)} → {nameOf(t.to)}</span><span>{rupiah(t.amount)}</span>
        </div>
      {/each}
      {#each doc.settlements as s (s.id)}
        <div class="line paid">
          <span>{nameOf(s.from)} → {nameOf(s.to)}</span>
          <span><span class="stamp">PAID</span> {rupiah(s.amount)}</span>
        </div>
      {/each}
      {#if summary.transfers.length === 0}
        <div class="center strong">{summary.settled ? '★ ALL SETTLED ★' : 'Nothing to settle yet'}</div>
      {/if}

      {#if payTo.length}
        <hr />
        <div class="section">PAY TO</div>
        {#each payTo as p (p.id)}
          <div class="pay">
            <strong>{p.name}</strong> · {p.payment?.bankName}<br />
            <span class="acct">{p.payment?.accountNumber}</span>
            {#if p.payment?.accountHolder}<br /><span class="dim">a.n. {p.payment.accountHolder}</span>{/if}
          </div>
        {/each}
      {/if}

      <hr />
      <div class="barcode" aria-hidden="true"></div>
      <footer class="center dim">
        Thank you · come again<br />
        {#if expiresAt}Link expires {new Date(expiresAt).toLocaleDateString('id-ID', { dateStyle: 'medium' })}{/if}
      </footer>
    </article>
  </div>
</div>

<style>
  .confetti {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 60;
    pointer-events: none;
  }

  .receipt {
    position: relative;
  }

  .printer {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 50px;
    padding: 0 16px 8px;
    font: 700 11px var(--mono);
    letter-spacing: 0.25em;
    color: #cfc8e8;
    background: linear-gradient(#3a3656, #2b2840);
    border: 2.5px solid #0b0a14;
    border-radius: 18px 18px 10px 10px;
    box-shadow: 4px 4px 0 #0b0a14;
  }

  .printing {
    animation: rumble 0.11s linear infinite;
  }

  .led {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #3ddc97;
    box-shadow: 0 0 8px #3ddc97;
  }

  .printing .led {
    background: #ffc533;
    box-shadow: 0 0 10px #ffc533;
    animation: blink 0.3s steps(2) infinite;
  }

  .slot {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: 7px;
    height: 6px;
    background: #0b0a14;
    border-radius: 3px;
  }

  .feed {
    overflow: hidden;
    margin: -10px 14px 0;
    padding: 0 6px 16px;
  }

  .paper {
    position: relative;
    padding: 28px 18px 14px;
    font: 400 13px/1.5 var(--mono);
    color: var(--paper-ink);
    background:
      repeating-linear-gradient(0deg, transparent 0 23px, rgb(0 0 0 / 2%) 23px 24px),
      var(--paper);
    box-shadow: 0 8px 16px rgb(0 0 0 / 14%);
    animation: feed var(--dur) steps(var(--steps), end) both;
  }

  /* The torn edge: one downward tooth per 16px tile. */
  .paper::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    height: 9px;
    background: conic-gradient(from -45deg at 50% 100%, var(--paper) 90deg, transparent 0) 0 0 / 16px 9px repeat-x;
  }

  h2 {
    margin: 4px 0;
    font: 700 1.05rem/1.2 var(--mono);
    text-transform: uppercase;
    overflow-wrap: anywhere;
  }

  .brand {
    font-weight: 700;
    letter-spacing: 0.5em;
    font-size: 0.8rem;
  }

  .center {
    text-align: center;
  }

  .dim {
    opacity: 0.6;
  }

  .strong {
    font-weight: 700;
  }

  .big {
    font-size: 15px;
    font-weight: 700;
  }

  .section {
    font-weight: 700;
    letter-spacing: 0.2em;
    margin-bottom: 2px;
  }

  hr {
    margin: 10px 0;
    border: 0;
    border-top: 2px dashed rgb(36 33 47 / 45%);
  }

  hr.double {
    border-top: 4px double rgb(36 33 47 / 70%);
  }

  .line {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .line > span:first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .line > span:last-child {
    flex: none;
    text-align: right;
  }

  .who {
    padding-left: 1.5ch;
    font-size: 11px;
    opacity: 0.6;
  }

  .me {
    margin: 0 -6px;
    padding: 0 6px;
    background: #fff0a0;
    font-weight: 700;
  }

  .pay {
    margin: 6px 0;
    padding: 6px 8px;
    border: 1.5px dashed rgb(36 33 47 / 40%);
  }

  .acct {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.06em;
  }

  .stamp {
    display: inline-block;
    padding: 0 5px;
    margin-right: 4px;
    font-weight: 700;
    font-size: 11px;
    color: #128a55;
    border: 2px solid #128a55;
    border-radius: 4px;
    transform: rotate(-10deg);
    animation: stamp 0.45s cubic-bezier(0.2, 1.8, 0.4, 1) both;
    animation-delay: var(--dur);
  }

  .barcode {
    height: 40px;
    margin: 4px 20px 8px;
    background: repeating-linear-gradient(
      90deg,
      #24212f 0 2px,
      transparent 2px 4px,
      #24212f 4px 5px,
      transparent 5px 8px,
      #24212f 8px 11px,
      transparent 11px 12px,
      #24212f 12px 13px,
      transparent 13px 17px
    );
  }

  @keyframes feed {
    from {
      transform: translateY(-100%);
    }
    to {
      transform: none;
    }
  }

  @keyframes rumble {
    50% {
      transform: translateX(1px) rotate(0.2deg);
    }
  }

  @keyframes blink {
    50% {
      opacity: 0.2;
    }
  }

  @keyframes stamp {
    from {
      opacity: 0;
      transform: scale(2.4) rotate(-10deg);
    }
    to {
      opacity: 1;
      transform: scale(1) rotate(-10deg);
    }
  }
</style>
