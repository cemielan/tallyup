# Requirements

`MUST` is required for the phase it belongs to, `SHOULD` is expected unless
there is a recorded reason not to, and `MAY` is optional.

## 1. Functional requirements

### Events and sharing

| ID | Requirement | Priority |
|---|---|---|
| FR-101 | A visitor MUST be able to create an event (a title and at least one person) without an account. | MUST |
| FR-102 | An event MUST support up to 30 people. Each person MAY carry payment details: bank name, account number (digits only) and an optional account holder name. The holder name is shown only when it is set. | MUST |
| FR-103 | An event MUST support up to 10 bills. Each bill has a payer, items (name, unit price, quantity, who shared it; nobody selected means everyone), and tax, service and discount amounts as printed. | MUST |
| FR-104 | Publishing MUST encrypt the event in the browser, upload only the ciphertext, and give the host a **view link** (to share) and a **host link** (to keep). | MUST |
| FR-105 | The host MUST be able to edit and republish. Concurrent saves MUST NOT silently overwrite each other (compare-and-swap on a version). | MUST |
| FR-106 | A share MUST expire 30 days after its last update. Expired shares MUST read as missing immediately and MUST be deleted by a daily sweep. | MUST |
| FR-107 | The host MUST be able to reset the share link (re-encrypt under a new key, invalidating old links) and to delete the event. | MUST |
| FR-108 | The host's event list MUST be kept on their device. The app MUST offer the host link as a backup, because losing local storage otherwise loses edit access. | MUST |

### Receipt scanning

| ID | Requirement | Priority |
|---|---|---|
| FR-201 | Receipt OCR MUST run entirely in the browser. The image MUST NOT be uploaded anywhere. | MUST |
| FR-202 | Scanned items MUST land in the normal bill editor for correction. When the receipt prints a total and the parsed bill does not match it, the editor MUST say so. | MUST |
| FR-203 | Typing a bill by hand MUST always be possible. Scanning is a shortcut, never a requirement. | MUST |

### Split and settle

| ID | Requirement | Priority |
|---|---|---|
| FR-301 | A shared item MUST be split equally among the people who had it. Tax, service and discount MUST be spread in proportion to each person's item subtotal. Shares MUST sum to the bill total exactly, to the rupiah. | MUST |
| FR-302 | The app MUST show each person's total and the fewest transfers that settle the event. | MUST |
| FR-303 | A viewer MUST be able to say who they are and then see what they owe, to whom, and the receiver's payment details when set. | MUST |
| FR-304 | A viewer MUST be able to send an "I paid" claim. The claim is encrypted like the event. | MUST |
| FR-305 | The host MUST be able to confirm a claim (recording the payment in the event) or decline it. The host MAY also mark a payment directly, and undo one. A viewer can never mark their own debt paid. | MUST |
| FR-306 | Multi-currency events MAY be added later. Until then, events are IDR only, in whole rupiah. | MAY |

### Open API

| ID | Requirement | Priority |
|---|---|---|
| FR-401 | The shares API MUST accept calls from any origin and MUST publish an OpenAPI document (`/v1/openapi.json`) with an interactive reference (`/docs`). | MUST |
| FR-402 | The event document format and the encryption scheme MUST be documented well enough for a third-party client to interoperate with the PWA (`docs/04-API-SPEC.md`). | MUST |

### The `debt-simplify` library

| ID | Requirement | Priority |
|---|---|---|
| FR-501 | All split and settlement math MUST go through the `debt-simplify` package. App code MUST NOT reimplement it. | MUST |
| FR-502 | A bug or gap found in `debt-simplify` MUST be fixed in the package, with a test in `test/debt-simplify.test.ts`, not patched around at the call site. | MUST |

### The app

| ID | Requirement | Priority |
|---|---|---|
| FR-601 | The app MUST be an installable PWA (manifest, icons, service worker). After the first visit, it MUST open offline. | MUST |
| FR-602 | The receipt MUST "print" with an animation. Confirmed payments MUST get a PAID stamp, and a fully settled event MUST celebrate. All motion MUST respect `prefers-reduced-motion`. | MUST |
| FR-603 | The app MUST be mobile-first and support light and dark colour schemes. | MUST |

## 2. Non-functional requirements

### Privacy and security

| ID | Requirement | Priority |
|---|---|---|
| NFR-101 | The server MUST NOT receive plaintext event data, keys or receipt images, by any route: requests, logs, or Referer headers. | MUST |
| NFR-102 | Every `MUST` in `docs/05-SECURITY.md` blocks phase completion. | MUST |
| NFR-103 | No secret may be committed. The Worker holds none. | MUST |

### Performance

| ID | Requirement | Priority |
|---|---|---|
| NFR-201 | p95 response time for `GET /v1/shares/:id` MUST be under 200 ms at the edge, excluding client network latency. | MUST |
| NFR-202 | Every request MUST fit the Workers Free 10 ms CPU budget. With no server-side computation, this means validation and one or two D1 statements per request. | MUST |
| NFR-203 | Initial JavaScript SHOULD stay under 100 KB gzipped. OCR assets (about 8 MB) MUST load only when someone scans. | SHOULD |

### Developer experience and operations

| ID | Requirement | Priority |
|---|---|---|
| NFR-301 | The OpenAPI document MUST be generated from the same Zod schemas the routes validate with. | MUST |
| NFR-302 | Every error response MUST use the single JSON envelope in `docs/04-API-SPEC.md` §4. | MUST |
| NFR-303 | A new developer MUST get from `git clone` to a running local instance in under 10 minutes using `docs/06-DEPLOYMENT.md`. | MUST |
| NFR-401 | The deployed system MUST cost $0/month at the traffic in `docs/02-ARCHITECTURE.md` §3. | MUST |
| NFR-402 | A projected free-tier overrun MUST be recorded in `docs/02-ARCHITECTURE.md` "Upgrade triggers", with its cheapest mitigation. | MUST |
| NFR-404 | CI MUST typecheck, build and run the full suite on every pull request. | MUST |

### Quality

| ID | Requirement | Priority |
|---|---|---|
| NFR-501 | Coverage of `src/` and `packages/` MUST stay above 80% (statements, branches, functions, lines). | MUST |
| NFR-502 | Every API route MUST have a happy-path test and an authorization-failure test, where it requires authorization. | MUST |
| NFR-503 | Dependabot MUST be enabled. | MUST |
| NFR-601 | Every control MUST have an accessible name. Focus MUST be visible. Touch targets MUST be at least 34 px (44 px for primary actions). | MUST |

## 3. Deferred, not forgotten

- **Indonesian-language UI.** The copy is English with Indonesian number and
  date formats.
- **QRIS or e-wallet payment details** alongside bank accounts.
- **Exporting the receipt as an image** for chats that do not unfurl links.
- **Push notifications** when a claim arrives. This needs a push service and
  a subscription store, which means the server would hold something about
  users.
