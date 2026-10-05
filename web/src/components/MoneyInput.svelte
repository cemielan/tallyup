<script lang="ts">
  import { LIMITS } from '../lib/doc';
  import { parseRupiah, rupiah } from '../lib/money';

  let { value = $bindable(0), label, id }: { value: number; label: string; id?: string } = $props();

  // Reformat on every keystroke ("35000" -> "35.000"). The DOM value is set
  // directly too, because typing a letter leaves `value` unchanged and
  // Svelte would otherwise leave the letter on screen.
  function oninput(event: Event & { currentTarget: HTMLInputElement }) {
    value = Math.min(parseRupiah(event.currentTarget.value), LIMITS.amount);
    event.currentTarget.value = value ? rupiah(value) : '';
  }
</script>

<input {id} class="money" inputmode="numeric" autocomplete="off" aria-label={label} placeholder="0" value={value ? rupiah(value) : ''} {oninput} />

<style>
  .money {
    font-family: var(--mono);
    text-align: right;
  }
</style>
