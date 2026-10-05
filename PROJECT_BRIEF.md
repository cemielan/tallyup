# Tallyup — Project Brief

> Start here. This file orients a developer (or an AI coding agent) to the
> whole project before touching any other doc. Read the docs in this
> order: this file → `docs/01-REQUIREMENTS.md` → `docs/02-ARCHITECTURE.md`
> → `docs/03-DATA-MODEL.md` → `docs/04-API-SPEC.md` → `docs/05-SECURITY.md`
> → `docs/06-DEPLOYMENT.md` → `docs/07-ROADMAP.md`.

## What this is

**Tallyup** is a split-bill and debt-payment **Progressive Web App**. Nobody
installs anything and nobody signs up. A host opens the site, adds the
people at the table, scans or types the bill, and sends one link. Friends
open that link to see what they owe, who to transfer to, and tap "I've paid".
The host confirms each payment until the receipt reads **ALL SETTLED**.

It does two jobs, and they are two stages of one flow:

1. **Split the bill:** work out each person's share. Items are charged to
   whoever had them. Tax, service and discount are spread in proportion to
   what each person ordered.
2. **Track the payback:** settle those shares with the fewest transfers, and
   record each payment as it is confirmed.

Both live in a single **event**. Bills create debt and confirmed payments
reduce it. Balances are always recomputed from those two lists and never
stored.

The **sharing API is open**. Any client that implements the documented
encryption scheme can create, read and update events through
`/v1/shares` (`docs/04-API-SPEC.md`).

## The design decision everything follows from

**The server never sees event data.** The browser encrypts the whole event
(names, items, amounts, bank details) with AES-256-GCM before upload. The
key lives only in the share link's `#fragment`, and browsers never send the
fragment to a server. The server stores ciphertext plus a hash of an edit
token. That's all it has.

Consequences that shape the rest of the codebase:

- **No accounts.** The server cannot list a user's events because it cannot
  read them. The host's event list lives on their device.
- **All money math runs in the browser,** through the `debt-simplify`
  workspace package.
- **The server can validate only shape and size,** not content. The browser
  validates the decrypted document with Zod and treats it as untrusted input.
- **Receipt photos never leave the device.** OCR runs in the browser
  (Tesseract.js, self-hosted).
- **The link is the credential.** Anyone holding the view link can read the
  event and add a payment claim. Only the edit token can change it.

## Non-goals (explicitly out of scope)

- **No real money movement.** A "payment" is a record that X paid Y back.
  The app shows the receiver's bank details; the transfer itself happens in
  the payer's own bank app. No payment gateway and no PCI scope.
- **No server-side accounts or sync** in this version. If cross-device
  history is ever needed, it must keep the server blind. One way is to wrap
  the event keys with a key derived from the user's password.
- **No server-side image processing,** however much more accurate cloud OCR
  would be. That would break the privacy promise the product is built on.

## Ground rules for whoever builds this

1. **Follow the phased roadmap in `docs/07-ROADMAP.md`.** Each phase has
   acceptance criteria. Treat them as the Definition of Done.
2. **Every requirement in `docs/01-REQUIREMENTS.md` has an ID**
   (FR-xxx / NFR-xxx). Cite the IDs in commits and PRs.
3. **Update `docs/02-ARCHITECTURE.md` before changing the stack.** The stack
   was chosen to stay inside free tiers and to keep the server blind. A swap
   has cost and privacy implications that need re-reasoning.
4. **Security controls in `docs/05-SECURITY.md` are requirements.** Any
   change that would let the server see plaintext is a design change, not
   an implementation detail.
5. **Re-verify free-tier numbers before relying on them.** The figures in
   `docs/02-ARCHITECTURE.md` come from Cloudflare's limits pages at
   research time, and Cloudflare can change them.
