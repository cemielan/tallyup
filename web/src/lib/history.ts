import type { EventDoc } from './doc';

/**
 * The host's event list lives on their device, not on the server: the
 * server cannot read events, so it cannot list them either.
 *
 * Ceiling, stated plainly: clearing site data loses this list, and with it
 * the edit token. Safari also evicts storage for sites not added to the Home
 * Screen after a stretch without visits. The host link backup in the share
 * sheet is the recovery path.
 */

export interface Entry {
  id: string;
  key: string;
  /** Present only for events this device hosts. */
  token?: string;
  title: string;
  /** The person this device speaks for, once chosen. */
  meId?: string;
  savedAt: number;
}

const ENTRIES = 'tallyup.events';
const DRAFT = 'tallyup.draft';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the app still works, it just forgets.
  }
}

export const listEntries = (): Entry[] =>
  read<Entry[]>(ENTRIES, []).sort((a, b) => b.savedAt - a.savedAt);

export const getEntry = (id: string): Entry | undefined => listEntries().find((e) => e.id === id);

/** Merge into an existing entry. A token, once known, is never dropped by a later viewer visit. */
export function saveEntry(entry: Partial<Entry> & { id: string }) {
  const all = listEntries();
  const current = all.find((e) => e.id === entry.id);
  const next = { ...current, ...entry, token: entry.token ?? current?.token, savedAt: Date.now() } as Entry;
  write(ENTRIES, [next, ...all.filter((e) => e.id !== entry.id)]);
  return next;
}

export function forgetEntry(id: string) {
  write(ENTRIES, listEntries().filter((e) => e.id !== id));
}

export const loadDraft = (): EventDoc | undefined => read<EventDoc | undefined>(DRAFT, undefined);
export const saveDraft = (doc: EventDoc | undefined) => write(DRAFT, doc);

/** Ask the browser not to evict our storage. Best effort; a refusal changes nothing. */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
