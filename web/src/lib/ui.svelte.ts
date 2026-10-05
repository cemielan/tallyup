/** Small UI helpers shared by every view: toasts, colours, sharing. */

export const toasts = $state<Array<{ id: number; text: string; tone: 'info' | 'error' }>>([]);

let nextToast = 0;

export function toast(text: string, tone: 'info' | 'error' = 'info') {
  const id = (nextToast += 1);
  toasts.push({ id, text, tone });
  setTimeout(() => {
    const index = toasts.findIndex((t) => t.id === id);
    if (index >= 0) toasts.splice(index, 1);
  }, 3500);
}

/** Show an error from anywhere without the caller caring what it was. */
export function fail(error: unknown) {
  toast(error instanceof Error ? error.message : 'Something went wrong', 'error');
}

const PALETTE = ['#ff8a65', '#7aa2ff', '#4fe0a0', '#ffd25e', '#c792ff', '#ff94c2', '#5fd6ea', '#b5e36b'];

/** A stable colour per person, by their position in the event. */
export const colorAt = (index: number) => PALETTE[index % PALETTE.length];

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

export async function copyText(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    // Clipboard needs a secure context and a user gesture; fall back to showing it.
    prompt('Copy this:', text);
  }
}

/** The native share sheet where there is one (phones), the clipboard elsewhere. */
export async function shareUrl(url: string, title: string) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text: `${title} — here's what you owe 🧾`, url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  await copyText(url, 'Link copied');
}
