<script lang="ts">
  import { LIMITS, type Bill, type Item, type Person } from '../lib/doc';
  import { rp, rupiah } from '../lib/money';
  import { readReceipt } from '../lib/ocr';
  import { parseReceipt } from '../lib/receipt-parser';
  import { lineTotal, type BillBreakdown } from '../lib/split';
  import { colorAt, fail, initials, toast } from '../lib/ui.svelte';
  import MoneyInput from './MoneyInput.svelte';

  let {
    bill = $bindable(),
    people,
    breakdown,
    onremove,
  }: { bill: Bill; people: Person[]; breakdown?: BillBreakdown; onremove: () => void } = $props();

  let scanning = $state(false);
  let progress = $state(0);
  let stage = $state('');
  /** The total printed on the last scanned receipt, to check the parse against. */
  let printedTotal = $state<number>();

  async function scan(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    scanning = true;
    progress = 0;
    try {
      const text = await readReceipt(file, (fraction, label) => {
        progress = fraction;
        stage = label;
      });
      const parsed = parseReceipt(text);
      if (parsed.items.length === 0) {
        toast("Couldn't find any items on that photo. Type them in instead.", 'error');
        return;
      }
      const added = parsed.items.slice(0, LIMITS.items - bill.items.length);
      bill.items.push(...added.map((item) => ({ ...item, for: [] })));
      if (parsed.tax) bill.tax = parsed.tax;
      if (parsed.service) bill.service = parsed.service;
      if (parsed.discount) bill.discount = parsed.discount;
      printedTotal = parsed.total;
      toast(`Found ${added.length} items. Check them, then tap who had what.`);
    } catch (error) {
      fail(error);
    } finally {
      scanning = false;
    }
  }

  function toggle(item: Item, id: string) {
    item.for = item.for.includes(id) ? item.for.filter((x) => x !== id) : [...item.for, id];
  }

  function setQty(item: Item, raw: string) {
    item.qty = Math.min(LIMITS.qty, Math.max(1, Number.parseInt(raw, 10) || 1));
  }
</script>

<section class="card stack bill">
  <div class="spread">
    <input class="bill-name" bind:value={bill.name} maxlength="60" aria-label="Bill name" />
    <button class="btn btn-icon btn-danger" aria-label="Remove {bill.name}" onclick={onremove}>✕</button>
  </div>

  <div class="field">
    <label class="label" for="paid-{bill.id}">Paid by</label>
    <select id="paid-{bill.id}" bind:value={bill.paidBy}>
      {#each people as p (p.id)}
        <option value={p.id}>{p.name}</option>
      {/each}
    </select>
  </div>

  <label class="btn btn-sun btn-block scan" class:scanning>
    <input type="file" accept="image/*" capture="environment" class="visually-hidden" onchange={scan} disabled={scanning} />
    {#if scanning}
      <span class="spin">🔍</span> {stage === 'recognizing text' ? `Reading… ${Math.round(progress * 100)}%` : 'Warming up the scanner…'}
    {:else}
      📸 Scan a receipt
    {/if}
  </label>
  <p class="muted small hint">Read on this device. The photo never leaves it.</p>

  {#each bill.items as item, i (i)}
    <div class="item">
      <div class="item-top">
        <input bind:value={item.name} placeholder="Item name" aria-label="Item name" maxlength={LIMITS.itemName} />
        <button class="btn btn-icon" aria-label="Remove item" onclick={() => bill.items.splice(i, 1)}>✕</button>
      </div>
      <div class="item-math">
        <input
          class="qty"
          inputmode="numeric"
          aria-label="Quantity"
          value={item.qty}
          onchange={(e) => setQty(item, e.currentTarget.value)}
        />
        <span class="muted">×</span>
        <MoneyInput bind:value={item.price} label="Unit price" />
        <span class="line-total">= {rupiah(lineTotal(item))}</span>
      </div>
      <div class="row who" role="group" aria-label="Who had {item.name || 'this item'}">
        <button class="chip mini" aria-pressed={item.for.length === 0} onclick={() => (item.for = [])}>Everyone</button>
        {#each people as p, pi (p.id)}
          <button class="chip mini" style="--c: {colorAt(pi)}" aria-pressed={item.for.includes(p.id)} onclick={() => toggle(item, p.id)}>
            <span class="avatar" style="--c: {colorAt(pi)}">{initials(p.name)}</span>{p.name}
          </button>
        {/each}
      </div>
    </div>
  {/each}

  <button class="btn btn-small" onclick={() => bill.items.push({ name: '', price: 0, qty: 1, for: [] })} disabled={bill.items.length >= LIMITS.items}>
    ＋ Add item
  </button>

  <div class="charges">
    <label class="field"><span class="label">Tax</span><MoneyInput bind:value={bill.tax} label="Tax" /></label>
    <label class="field"><span class="label">Service</span><MoneyInput bind:value={bill.service} label="Service charge" /></label>
    <label class="field"><span class="label">Discount</span><MoneyInput bind:value={bill.discount} label="Discount" /></label>
  </div>

  {#if breakdown}
    <div class="totals">
      <div class="spread"><span class="muted">Subtotal</span><span>{rp(breakdown.subtotal)}</span></div>
      <div class="spread total"><span>Total</span><span>{rp(Math.max(0, breakdown.total))}</span></div>
    </div>
    {#if breakdown.error && bill.items.length > 0}
      <div class="notice error">{breakdown.error}</div>
    {/if}
    {#if printedTotal !== undefined && printedTotal !== breakdown.total}
      <div class="notice">
        The receipt says {rp(printedTotal)}, but this bill adds up to {rp(breakdown.total)}. A misread price is the usual cause.
      </div>
    {/if}
  {/if}
</section>

<style>
  .bill-name {
    font-size: 1.2rem;
    font-weight: 800;
    border: none;
    border-bottom: 2px dashed color-mix(in srgb, var(--ink) 30%, transparent);
    border-radius: 0;
    padding-left: 0;
    background: transparent;
  }

  .scan {
    border-radius: var(--radius);
    min-height: 54px;
    font-size: 1.05rem;
  }

  .scanning {
    background: repeating-linear-gradient(-45deg, var(--sun) 0 14px, #ffdb7a 14px 28px);
    background-size: 200% 100%;
    animation: stripes 1s linear infinite;
  }

  .spin {
    display: inline-block;
    animation: wobble 0.6s ease-in-out infinite alternate;
  }

  .hint {
    margin: -6px 0 0;
    text-align: center;
  }

  .item {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 2px solid color-mix(in srgb, var(--ink) 15%, transparent);
    border-radius: 12px;
  }

  .item-top {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
  }

  .item-math {
    display: grid;
    grid-template-columns: 56px auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
  }

  .qty {
    text-align: center;
    font-family: var(--mono);
  }

  .line-total {
    font-family: var(--mono);
    font-weight: 700;
    white-space: nowrap;
  }

  .who {
    gap: 6px;
  }

  .chip.mini {
    min-height: 32px;
    padding: 2px 10px 2px 2px;
    font-size: 0.8rem;
  }

  .chip.mini:first-child {
    padding-left: 10px;
  }

  .chip.mini .avatar {
    width: 24px;
    height: 24px;
    font-size: 0.65rem;
  }

  .charges {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .totals {
    display: grid;
    gap: 2px;
    font-family: var(--mono);
  }

  .total {
    font-size: 1.15rem;
    font-weight: 700;
  }

  @keyframes stripes {
    to {
      background-position: -56px 0;
    }
  }

  @keyframes wobble {
    to {
      transform: rotate(-15deg) scale(1.15);
    }
  }
</style>
