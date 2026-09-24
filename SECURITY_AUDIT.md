# SECURITY AUDIT — Aurora Support (AI Customer Support Agent)

- **Date:** 2026-09-21
- **Auditor:** application security review (static, read-only; no code changes made)
- **Scope:** entire repository (`C:\Users\Karan kaushal\Downloads\AI Customer Support Agent`), git history, configuration, DB layer, auth flows, all API routes, dependencies, deployment config
- **Baseline:** OWASP Top 10 (2021), OWASP API Security Top 10, Next.js platform guidance
- **Note:** findings are evidence-based from code/config. Items that need live-system testing are labeled [NEEDS MANUAL REVIEW].

---

## SECURITY AUDIT SUMMARY

**Critical (2):**
1. Universal demo-password backdoor — `demo1234` logs in as *any* account, including admin
2. Live SQLite WAL files committed to git — password hashes, PII, and session data in repo history

**High (4):**
3. No rate limiting / lockout on login (brute force)
4. Next.js 15.1.6 with multiple unpatched advisories (npm audit: critical range)
5. drizzle-orm 0.38.2 flagged HIGH (SQL-injection-via-identifiers advisory)
6. `SESSION_SECRET` silently falls back to a hardcoded dev value in production; token signature is never verified (dead code)

**Medium (5):**
7. Login errors allow account enumeration
8. No security headers (CSP, X-Frame-Options, HSTS, etc.)
9. Internal error messages leaked to clients on 500s
10. `update_support_ticket` is role-checked only by the tool-visibility list (no handler-level or policy-level staff check)
11. No rate limit / cost cap on the LLM-backed `/api/chat` endpoint

**Low (6):**
12. PBKDF2-SHA256 at 120k iterations (below current OWASP guidance)
13. Semi-predictable business IDs (`Math.random()` component); SQLite file permissions on Linux hosts
14. No OpenAI `fetch` timeout; logout CSRF (negligible); password min length 4 (no signup flow)
15. Dev-only vulnerable packages (playwright, esbuild, vitest)
16. Committed screenshots may contain demo PII; no server-side page gate for `/admin` `/support` (data APIs are gated)

---

## REMEDIATION STATUS (2026-09-21, post-audit pass)

All code-side fixes were implemented and verified under Node v24.19.0:
102 vitest tests (incl. `tests/unit/security-hardening.test.ts`), typecheck,
lint, production build, and Playwright E2E (core-flow + support-dashboard).

| # | Status | What was done |
|---|--------|---------------|
| 1 | **Fixed** | `demo1234` accepted only when `NODE_ENV !== "production"` ([auth.ts:17-20](src/lib/auth.ts#L17)); demo hints hidden on the login page in production; boot gate refuses a production start without `SESSION_SECRET` and warns on a mock LLM. Unit test `F1`. |
| 2 | **Partial — manual work remains** | `.gitignore` now excludes `data/`, `*.db-wal`, `*.db-shm`, `*.db-journal`; the four tracked sidecar files are untracked at HEAD (`git rm --cached`). **Manual:** purge them from git history (`git filter-repo --path data/ --invert-paths` or a fresh repo), revoke existing sessions, re-seed passwords; if the repo was ever pushed, treat the hashes/tokens as compromised. |
| 3 | **Fixed** | Fixed-window limiter: 8 attempts / 10 min per IP and per account → 429; failed attempts logged with email + IP (never the password). Unit test `F3`. |
| 4 | **Fixed (residual noted)** | `next` 15.1.6 → **15.5.25**. Residual: next's nested `postcss` still matches a HIGH advisory whose fix only ships in next 16.3.5 (major bump, deferred — build-time tooling surface, no app-level attack path); revisit when upgrading to Next 16. |
| 5 | **Fixed** | `drizzle-orm` 0.38.2 → **0.45.3**. |
| 6 | **Fixed** | `sessionSecret()` throws in production when unset; `src/instrumentation.ts` boot gate fails the process; session tokens are now HMAC-signed and the signature is verified in `getPrincipal()` (mismatch → revoke). Unit test `F6`. |
| 7 | **Fixed** | Single generic "Invalid email or password." for both cases; the distinction is server-log only. Unit test `F7`. |
| 8 | **Fixed** | nosniff / X-Frame-Options DENY / Referrer-Policy / HSTS(preload) on every response; strict CSP in production builds (no `unsafe-eval`; `script-src 'unsafe-inline'` is required for App Router RSC flight scripts — documented in next.config.ts). CSP is omitted in dev because the dev toolchain needs `eval()`. Unit test `F8`. |
| 9 | **Fixed** | 500s return a generic "Internal error."; the full error is logged server-side. |
| 10 | **Fixed** | `authorize()` requires `isStaff` for `update_support_ticket` and the handler itself throws FORBIDDEN for non-staff. Unit test `F10` (direct `runTool` with a customer principal). |
| 11 | **Fixed** | Per-customer chat cap: 60 turns / 10 min (`CHAT_TURNS_PER_WINDOW` / `CHAT_WINDOW_MS`) → 429. Unit test (rate limiter). |
| 12 | **Fixed** | PBKDF2-SHA256 at 600k iterations; legacy 120k hashes still verify. Unit test `F12`. |
| 13 | **Fixed** | `genId` fully CSPRNG (`crypto.randomInt`); SQLite file + WAL/SHM created with 0600 on Unix. Unit test `F13`. |
| 14 | **Fixed** | `AbortSignal.timeout(60s)` on the LLM fetch with a generic error message (no `e.message` leakage); logout requires a JSON body (all client call sites updated). |
| 15 | **Partial** | `@playwright/test` 1.50.1 → **1.63.0**, `vitest` → **3.2.7**. Residual dev-only (no runtime impact): `esbuild ≤0.24.2` (transitive via tsx/vite/drizzle-kit) and `@vitest/mocker` (fixed in vitest 5, a breaking bump) — revisit on the next dev-toolchain upgrade; keep `npm audit` in CI. |
| 16 | **Partial** | `/admin` and `/support` now have server-side (RSC layout) auth + role gates that redirect unauthenticated / under-privileged visitors; data APIs remain independently gated. **Manual:** visually review `images/*.jpg` for PII before publishing the repo. |

---

## FINDINGS

---

### Finding 1: Universal demo-password backdoor (any account, incl. admin)

- **Severity:** CRITICAL
- **Location/File:** [src/lib/auth.ts:16](src/lib/auth.ts#L16), [src/lib/auth.ts:30](src/lib/auth.ts#L30); corroborated by [src/db/seed.ts:20-38](src/db/seed.ts#L20), [src/app/login/page.tsx:8-13](src/app/login/page.tsx#L8), [README.md:24-31](README.md#L24)
- **Evidence:**
  ```ts
  // auth.ts
  export const DEMO_PASSWORD = "demo1234";
  ...
  const ok = password === DEMO_PASSWORD || verifyPassword(password, row.passwordHash);
  ```
  The login page *displays* the password and lists all four account emails (customer, customer-2, support, admin). The README documents the same.
- **Why it matters:** Authentication is bypassed for **every** account. Anyone who can reach `/api/auth/login` can sign in as `admin@example.com` — the role that approves refunds and reads the full audit trail.
- **How it could be abused:** `POST /api/auth/login {"email":"admin@example.com","password":"demo1234"}` → admin session → `POST /api/approvals/:id/decision {"approve":true}` → execute refunds against any customer's order. Full financial + PII compromise. No attack sophistication required; the credentials are on the public login screen.
- **Recommended fix:**
  1. Remove the `DEMO_PASSWORD` bypass entirely, or gate it: `const ok = (process.env.NODE_ENV !== "production" && password === DEMO_PASSWORD) || verifyPassword(...)`.
  2. In production, refuse to start (fail fast) if the seeded demo accounts exist, or require real passwords + a sign-up/SSO flow.
  3. Hide demo account hints from the login UI when not in a demo mode.
- **Verification test:** In a production-mode run, attempt login for each seeded email with `demo1234` → must return 401; with a known real password hash → 200. Add a unit test asserting `login()` rejects `DEMO_PASSWORD` when `NODE_ENV === "production"`.

---

### Finding 2: SQLite WAL/SHM database files committed to git history

- **Severity:** CRITICAL
- **Location/File:** tracked at HEAD: `data/app.db-wal`, `data/app.db-shm`, `data/e2e.db-wal`, `data/e2e.db-shm` (visible in `git ls-files`); gap in [.gitignore:33-35](.gitignore#L33)
- **Evidence:**
  - `.gitignore` ignores `*.db` but **not** `*.db-wal` / `*.db-shm`; all four sidecar files are tracked (added in the initial commit, re-touched in the second commit).
  - Content scan of `git show HEAD:data/app.db-wal` (1,273,309 bytes): **5 × `pbkdf2$...` password hashes**, `jane@example.com`, `admin@example.com`, `riley@support.example.com`, `CUST-1001`, `ORD-1001` all present. `e2e.db-wal` also contains `pbkdf2` + `jane@example.com`.
- **Why it matters:** A SQLite WAL holds recent database pages — effectively a partial (sometimes complete) copy of the live DB: password hashes, session tokens, chat PII, orders, audit rows. This is real credential + PII exposure in version control.
- **How it could be abused:** Any clone of the repo (or a public remote, if pushed) yields password hashes. The seeded passwords are the weak, publicly documented `demo1234` → instant account takeover (compounds Finding 1). Any session tokens present in the WAL are valid until expiry (7 days) — silent account takeover without a login event.
- **Recommended fix:**
  1. **Removing the files alone is NOT enough** — the data remains in history. Either (a) rewrite history with `git filter-repo --path data/ --invert-paths` and force-push, or (b) start a fresh repository (simplest for a project this size).
  2. Treat the leaked hashes as compromised: after the fix, re-seed with new passwords and **revoke all existing sessions** (the `sessions` table).
  3. If this repo was ever pushed to a public remote, assume public exposure and rotate everything (secrets in `.env`, DB data, any real credentials that ever lived in that DB).
  4. Fix `.gitignore`: add `*.db-wal`, `*.db-shm`, `*.db-journal`, and `data/`.
- **Verification test:** On the new/rewritten repo: `git log --all --pretty=format: --name-only | grep -E 'data/.*\.(db|wal|shm)'` returns nothing; `git ls-files | grep data` returns nothing; a secret scanner (gitleaks/trufflehog) on full history is clean.

---

### Finding 3: No brute-force protection on login

- **Severity:** HIGH
- **Location/File:** [src/app/api/auth/login/route.ts](src/app/api/auth/login/route.ts) (whole file — no limiter)
- **Evidence:** The route parses the body and calls `login()` directly. There is no per-IP or per-account rate limit, no lockout, no CAPTCHA, no failed-attempt counter anywhere in the repo (grep for rate-limit/lockout/throttle returns nothing).
- **Why it matters:** Unlimited online password guessing against any account. PBKDF2-120k slows each attempt somewhat server-side, but there is no ceiling on attempts.
- **How it could be abused:** Automated loop: `POST /api/auth/login` with a password wordlist per email (emails are enumerable — see Finding 7). With Finding 1 present this is moot (`demo1234` works), but after the backdoor is fixed, this is the primary remaining auth attack.
- **Recommended fix:** Add rate limiting at the application or reverse-proxy layer (e.g., per-IP 5 min/max-10, per-account exponential backoff, temporary lockout after N failures). Log failed attempts with source IP for alerting.
- **Verification test:** Send 15 rapid failed logins from one IP/account; expect a 429/lockout and an audit/log entry.

---

### Finding 4: Outdated Next.js with unpatched advisories

- **Severity:** HIGH
- **Location/File:** [package.json:25](package.json#L25) (`"next": "15.1.6"`)
- **Evidence:** `npm audit` (run under Node v24.19.0) reports `next 9.3.4-canary.0 - 16.3.0-preview.10` in the **critical** aggregate range, including: unauthenticated RCE on Windows-hosted servers, RCE in image optimization (AVIF), unauthenticated disclosure of internal Server Function endpoints, RSC cache-confusion/poisoning DoS, and others. Fix: `next@15.5.25` (same major line).
- **Why it matters:** Framework-level vulnerabilities are exploitable without app bugs. Several listed advisories are feature-specific (this app has no middleware, rewrites, or server actions), but the Windows-RCE and RSC cache-confusion entries apply to general App Router deployments — and this app is developed/deployed on Windows.
- **How it could be abused:** Depends on advisory; e.g., the cache-confusion DoS and Windows RCE advisories are reachable against a standard `next start` deployment.
- **Recommended fix:** `npm install next@^15.5` (stays on 15.x, minor bump), re-run `typecheck`, `lint`, full `vitest`, `build`, and Playwright E2E to confirm no regressions.
- **Verification test:** `npm audit` no longer lists `next`; full test suite green; spot-check login/chat/approval flows in the built app.

---

### Finding 5: drizzle-orm flagged HIGH (SQL injection via identifier escaping)

- **Severity:** HIGH (dependency) / LOW (practical exploitability in this codebase)
- **Location/File:** [package.json:23](package.json#L23) (`"drizzle-orm": "0.38.2"`), used throughout [src/db/repos.ts](src/db/repos.ts)
- **Evidence:** `npm audit`: `drizzle-orm <0.45.2 — HIGH: SQL injection via improperly escaped SQL identifiers (GHSA-gpj5-g38j-94v9)`.
  Code review: all table/column identifiers in this app come from the static schema objects in `src/db/schema.ts` / `schema.pg.ts`; user input is used only as **bound values** (e.g., `like(table.col, \`%${q}%\`)` at [repos.ts:153](src/db/repos.ts#L153) is a value, not an identifier). I found no code path where untrusted input reaches an identifier position.
- **Why it matters:** This is the app's SQL layer. If any future code passes untrusted data into `db(table[userInput])` / column builders, the vulnerable version turns that into SQLi. Shipping a known-HIGH SQL library version in a security-sensitive app is a pre-launch blocker even when currently unexploitable.
- **How it could be abused:** Not exploitable with the current code (verified by review); exploitable if identifier interpolation is introduced later.
- **Recommended fix:** Upgrade to `drizzle-orm@>=0.45.3`. npm marks this as a breaking change across minor versions — after upgrading, re-run the full suite (`typecheck`, `lint`, `vitest` incl. integration tests that exercise both the SQLite and the Postgres repo code paths, `build`) and re-apply `.db/schema.sql` / `schema.pg.sql` against a scratch DB.
- **Verification test:** `npm audit` clean for drizzle; all 86 existing tests pass; a scratch Postgres migration run succeeds.

---

### Finding 6: Session secret fallback + unverified token signature

- **Severity:** HIGH
- **Location/File:** [src/lib/env.ts:70-72](src/lib/env.ts#L70); [src/lib/auth.ts:40-45](src/lib/auth.ts#L40), [src/lib/auth.ts:52-63](src/lib/auth.ts#L52); [README.md:451](README.md#L451)
- **Evidence:**
  ```ts
  // env.ts
  export function sessionSecret(): string {
    return envStr("SESSION_SECRET", "dev-insecure-secret-change-me");
  }
  ```
  - README says "Set a long random string in production" but **nothing enforces it** — a production boot with no `SESSION_SECRET` succeeds using the hardcoded dev value.
  - `signToken()` produces an HMAC over `customerId:expiresAt` (truncated to 16 hex chars), but `getPrincipal()` never verifies the signature — session validity is established **only** by a DB lookup of the full token ([auth.ts:54](src/lib/auth.ts#L54)). The signature is dead code, and the truncated (64-bit) HMAC would be weak if it were ever used as the sole check.
- **Why it matters:** (a) A known signing secret in production is a latent forge vector the moment anyone adds signature verification; (b) the dead code is a false sense of security for anyone maintaining the auth path.
- **How it could be abused:** Not directly exploitable today (session tokens are 128-bit random + DB-verified). Risk is future-state and trust-model: an operator who assumes "tokens are HMAC-signed" would be wrong.
- **Recommended fix:**
  1. Fail fast at boot in production when `SESSION_SECRET` is missing or equals the dev fallback (and ideally when `LLM_PROVIDER=mock` is also active, per your deployment intent).
  2. Either verify the signature in `getPrincipal()` (using the full, untruncated HMAC) or delete `signToken` to avoid dead code.
- **Verification test:** Boot the production build with no `SESSION_SECRET` → process must exit non-zero with a clear message. Unit test: `getPrincipal` rejects a token whose DB row is absent or expired.

---

### Finding 7: Account enumeration via distinct login errors

- **Severity:** MEDIUM
- **Location/File:** [src/lib/auth.ts:29-31](src/lib/auth.ts#L29)
- **Evidence:**
  ```ts
  if (!row) throw Errors.unauthorized("No account found for that email.");
  const ok = ...;
  if (!ok) throw Errors.unauthorized("Incorrect password.");
  ```
  Two different messages for "unknown email" vs "wrong password", returned verbatim to the client by `httpError`.
- **Why it matters:** An attacker can confirm which emails are registered before brute-forcing (Finding 3) or targeting (Finding 1).
- **How it could be abused:** Loop over an email wordlist; different error text reveals valid accounts (e.g., `admin@example.com` exists).
- **Recommended fix:** Return a single generic message ("Invalid email or password.") for both cases; keep the distinction in server logs only.
- **Verification test:** POST login with unknown email vs known email/wrong password → identical response body and status.

---

### Finding 8: No security headers (CSP, framing, HSTS, etc.)

- **Severity:** MEDIUM
- **Location/File:** [next.config.ts](next.config.ts) (no `headers()`), [src/app/layout.tsx](src/app/layout.tsx) (no `headers` metadata)
- **Evidence:** No `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`/frame-ancestors, `Referrer-Policy`, or `Strict-Transport-Security` anywhere in the config.
- **Why it matters:** No XSS sink exists in the current UI (all user content is rendered as React text — verified: zero `dangerouslySetInnerHTML` in `src/`), but without CSP/XCTO there is no defense-in-depth if one is introduced, and the app can be clickjacked via framing (no `frame-ancestors`).
- **How it could be abused:** Clickjacking of the admin approval console (frame the Approve button under a transparent overlay); amplified impact of any future XSS.
- **Recommended fix:** Add to `next.config.ts`:
  ```ts
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" },
      ],
    }];
  }
  ```
  (Adjust CSP if inline styles/fonts change; `next/font` and Tailwind may need `style-src` tuning.)
- **Verification test:** `curl -I` (or browser devtools) on `/login` shows all headers; attempt to frame the app in an iframe → blocked.

---

### Finding 9: Internal error details leaked to clients

- **Severity:** MEDIUM
- **Location/File:** [src/app/api/_util.ts:27-30](src/app/api/_util.ts#L27)
- **Evidence:**
  ```ts
  return NextResponse.json(
    { error: { code: "INTERNAL", message: e instanceof Error ? e.message : "Internal error" } },
    { status: 500 },
  );
  ```
  Any non-`AppError` exception's raw `message` is returned. Driver exceptions (better-sqlite3 / postgres-js) include SQL fragments, table names, constraint names, and sometimes file paths.
- **Why it matters:** Information disclosure (OWASP A05) — helps an attacker map the schema and confirm error paths (e.g., SQL constraint violations reveal valid/invalid field values).
- **How it could be abused:** Craft requests that trigger DB errors (bad JSON in tool args reaching raw paths, malformed ids) and read the returned SQL/constraint text.
- **Recommended fix:** In the catch-all branch, log `e` server-side (with stack) and return only `{ error: { code: "INTERNAL", message: "Internal error." } }`.
- **Verification test:** Force a 500 (e.g., corrupt the DB file in a scratch env) → response contains no SQL, paths, or stack.

---

### Finding 10: `update_support_ticket` staff check relies on a single layer

- **Severity:** MEDIUM
- **Location/File:** [src/lib/policy.ts:89-91](src/lib/policy.ts#L89) and [src/lib/policy.ts:108-121](src/lib/policy.ts#L108); handler [src/lib/tools.ts:573-600](src/lib/tools.ts#L573)
- **Evidence:**
  ```ts
  // policy.ts — no role condition:
  if (toolName === "create_support_ticket" || toolName === "update_support_ticket") {
    return { allowed: true };
  }
  ```
  The tool description and the `/support` API say "staff only", and the *only* enforcement for chat-tool access is that `visibleToolsFor("customer")` omits `update_support_ticket` (the agent loop rejects non-visible tools before `authorize()` runs). The handler itself performs no staff check.
- **Why it matters:** Broken function-level authorization (OWASP API12/A01) one refactor away. Any new entry point that calls `runTool` with a customer principal (a future API route, a staff-tool visibility "improvement", an admin-tool export) silently grants customers the ability to modify **any** ticket, including writing internal notes.
- **How it could be abused:** Currently blocked via the visibility list (verified). Latent: customer → `update_support_ticket` → tamper with other customers' tickets/notes.
- **Recommended fix:** Add explicit guards in two places: `authorize()` → require `isStaff(role)` for `update_support_ticket`; and in the handler: `if (!isStaff(ctx.principal.role)) throw Errors.forbidden(...)`. Add a unit test (customer principal, direct `runTool`) asserting FORBIDDEN.
- **Verification test:** New unit test: `runTool(customerCtx, "update_support_ticket", {ticketId:"TCK-1"})` → `FORBIDDEN`; staff → success.

---

### Finding 11: No rate limiting / cost cap on `/api/chat` (LLM spend)

- **Severity:** MEDIUM
- **Location/File:** [src/app/api/chat/route.ts](src/app/api/chat/route.ts)
- **Evidence:** Each POST runs the agent loop up to `AGENT_MAX_ITERATIONS` (default 6) LLM iterations. With a real `OPENAI_API_KEY`, that's up to 6 paid completions per user message, unbounded per user per time. No per-session or per-account throttle, no concurrency cap, no daily quota. (Message length is capped at 4000 chars — good.)
- **Why it matters:** Economic DoS / resource abuse (OWASP API3 Broken Resource Consumption). One compromised or malicious session can drain the LLM budget or stall the app. Combined with Finding 1 (anyone can get an admin session), the blast radius is the whole account.
- **How it could be abused:** Scripted loop posting to `/api/chat` → unbounded OpenAI spend / server saturation.
- **Recommended fix:** Per-session token-bucket (e.g., ≤ N turns/minute, ≤ M turns/day), optionally per-IP for anonymous abuse; reject with 429. Add an OpenAI request timeout (see Finding 14). Monitor spend alerts on the provider side.
- **Verification test:** Fire 30 chat requests in 10s from one session → 429 after the cap; verify provider spend stays bounded.

---

### Finding 12: Password hashing below current guidance

- **Severity:** LOW
- **Location/File:** [src/lib/security.ts:12-18](src/lib/security.ts#L12)
- **Evidence:** `pbkdf2Sync(password, salt, 120_000, 32, "sha256")` — PBKDF2-SHA256 @ 120k iterations (Node's historical default). OWASP currently recommends ≥600k for PBKDF2-SHA256, or Argon2id/scrypt.
- **Why it matters:** Offline cracking of leaked hashes is faster than it should be (relevant because Finding 2 already leaked hashes).
- **How it could be abused:** Post-exfiltration GPU cracking of the 5 seeded hashes (trivial anyway since the password is the public `demo1234`).
- **Recommended fix:** Bump to 600k+ iterations (one-time cost on verify of ~tens of ms — acceptable) or migrate to scrypt/argon2id with a hash-upgrade-on-login path.
- **Verification test:** New hashes store `pbkdf2$600000$...`; login still works for legacy 120k hashes (upgrade on next login).

---

### Finding 13: ID predictability & SQLite file permissions

- **Severity:** LOW
- **Location/File:** [src/lib/ids.ts:8-12](src/lib/ids.ts#L8); [src/db/client.ts:52-61](src/db/client.ts#L52)
- **Evidence:**
  - `genId` = prefix + `Math.random()`-derived 4-digit number + 4 hex chars (16 bits crypto). Ticket/approval/refund IDs are partially predictable.
  - SQLite files are created with default umask (typically 0644 on Linux) — world-readable DB containing hashes/sessions/PII.
- **Why it matters:** ID secrecy is **not** the access control here (ownership is enforced server-side — verified, see "Attacker test"), so predictability alone doesn't enable IDOR. It matters if any future feature relies on "unguessable ID" as a secret. The 0644 DB file is a real exposure on multi-user Linux hosts.
- **How it could be abused:** Sequential probing of `TCK-####`/`APR-####` IDs via staff endpoints would be easy if role checks were missing (they aren't). On a shared Linux box, another local user reads `data/app.db`.
- **Recommended fix:** Replace the `Math.random()` portion with `randomBytes` fully; on Linux deployments run the app as a dedicated user and `chmod 600` the DB directory (or just use Postgres in production).
- **Verification test:** Generated IDs contain no enumerable numeric sequence; `ls -l data/app.db` shows owner-only perms in the target environment.

---

### Finding 14: No timeout on the OpenAI fetch; minor auth hygiene items

- **Severity:** LOW
- **Location/File:** [src/lib/openai.ts:44-51](src/lib/openai.ts#L44); [src/app/api/auth/logout/route.ts](src/app/api/auth/logout/route.ts); [src/app/api/auth/login/route.ts:7](src/app/api/auth/login/route.ts)
- **Evidence:**
  - `fetch(baseUrl + "/chat/completions", ...)` has no `AbortController`/timeout — a hung upstream LLM endpoint holds the request/worker indefinitely.
  - `POST /api/auth/logout` requires no body; a cross-site top-level form POST can log a user out (SameSite=Lax permits top-level form POSTs) — logout CSRF, negligible impact.
  - Login password validator is `z.string().min(4)` — there is no signup flow, so this only matters if one is added.
- **Why it matters:** Availability (hung requests) and minor hygiene.
- **Recommended fix:** Add `signal: AbortSignal.timeout(30_000)` to the LLM fetch; if logout CSRF matters, require a small JSON body or token; enforce a real password policy (min 10-12 chars, no known-password check) if signup is ever added.
- **Verification test:** Point `OPENAI_BASE_URL` at a black-hole endpoint → request fails fast with a tool error, not an open handle.

---

### Finding 15: Dev-only vulnerable packages (no production impact)

- **Severity:** LOW
- **Location/File:** `package-lock.json` / devDependencies
- **Evidence:** `npm audit` (Node v24.19.0): `playwright <1.55.1` (HIGH — browser downloads without SSL verification), `esbuild <=0.24.2` (MODERATE — dev-server origin issue), `vitest/@vitest/mocker` (MODERATE — test-tool path traversal). All are devDependencies not present in `next start`'s runtime bundle.
- **Why it matters:** Build/test-time risk (supply-chain on the dev machine), not runtime.
- **Recommended fix:** Bump devDeps on the next maintenance pass (`@playwright/test@^1.55`, `esbuild` transitively via `drizzle-kit@0.31` / `vite` updates); keep `npm audit` in CI.
- **Verification test:** `npm audit --omit=dev` clean for production deps; full audit clean after devDeps bump.

---

### Finding 16: Committed demo screenshots; no server-side page gate

- **Severity:** LOW
- **Location/File:** `images/*.jpg` (9 committed screenshots, incl. `login.jpg` showing demo credentials); [src/app/admin/page.tsx](src/app/admin/page.tsx), [src/app/support/page.tsx](src/app/support/page.tsx)
- **Evidence:** Screenshots are demo data (review visually for anything beyond seed PII). `/admin` and `/support` are client components that redirect after an `/api/auth/me` check — the page HTML itself is served to anonymous visitors, but **every data API behind them is role-gated** (verified per route).
- **Why it matters:** Cosmetic/info-disclosure; the actual data boundary is enforced server-side, so this is not an access control failure.
- **Recommended fix:** Optional: add server-side `redirect("/login")` for unauthenticated visits in these routes' layout or page (Next 15: read cookies in the server component wrapper). Review screenshots before publishing the repo.
- **Verification test:** Unauthenticated GET `/admin` shows only the empty shell (no data); after the optional fix, it redirects.

---

## What I verified as SOUND (with evidence)

| Area | Verdict | Evidence |
|---|---|---|
| IDOR/BOLA on orders | PASS | `findOrderFor` ([tools.ts:81-88](src/lib/tools.ts#L81)) returns NOT_FOUND for foreign/unknown orders (no existence leak); customers locked to own data; `ORD-9999` cross-customer fixture exists specifically for this |
| Refund targeting | PASS | `resolveRefundCustomer` ([tools.ts:95-115](src/lib/tools.ts#L95)) rejects customer→other-account (FORBIDDEN); staff customerId must own the order |
| Ticket creation targeting | PASS | `resolveTicketCustomer` ([tools.ts:133-150](src/lib/tools.ts#L133)) forbids customer→other-account |
| Admin-only endpoints | PASS | `/api/audit` (admin), `/api/approvals/:id/decision` (admin + `decideApproval`/`executeApprovedAction` re-check role internally), `/api/tickets` (staff) all use `requireRole` server-side |
| Approval execution | PASS | Arguments are read from the stored approval record, never from the caller ([approvals.ts:177-219](src/lib/approvals.ts#L177)); idempotency key bound to approval; balance re-checked; single transaction |
| Session handling | PASS (with F6) | 128-bit random token, DB-verified, 7-day TTL checked on every request, revocable on logout; cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production |
| SQL injection | PASS (app code) | All queries via Drizzle with static identifiers; user input only as bound values (LIKE patterns at repos.ts:153/275/419/544 are values); no `sql` template with user input; no raw user-controlled SQL |
| XSS | PASS | Zero `dangerouslySetInnerHTML`/`innerHTML`/`eval`/dynamic-`Function` in `src/`; chat content rendered as text (`<p>{m.content}</p>`); React auto-escaping applies |
| Command/path traversal | PASS | No `child_process`, no user-controlled file paths (`fs` only reads fixed `.db/schema*.sql`); `DATABASE_PATH` is server env only |
| Secrets in client bundle | PASS | No `NEXT_PUBLIC_*` vars; `OPENAI_API_KEY`/`DATABASE_URL`/`SESSION_SECRET` read only in server modules; API keys never sent to the browser |
| Prompt-injection containment | PASS (design) | LLM only *proposes* tools; loop enforces visibility + `authorize()` + Zod validation + risk gate per call ([agent.ts:89-143](src/lib/agent.ts#L89)); internal `process_refund` never exposed and never authorized via tool path |
| Audit logging | PASS (design) | All significant actions logged with actor/args/result, secrets redacted (`SECRET_KEYS` in [audit.ts:11-19](src/lib/audit.ts#L11)), 4 KB truncation |
| File uploads | N/A | No upload endpoints or storage buckets exist |
| CORS | PASS (default) | No CORS headers configured anywhere; cross-origin API calls cannot read responses; cookie `SameSite=Lax`; JSON-body requirement further limits CSRF |
| Debug exposure | PASS | No debug mode flags; production build only (dev server issues are advisory-only, see F4) |
| .env handling | PASS | `.env`/`.env.local` git-ignored; only `.env.example` (placeholders) and committed `.env.test` (no secrets) are in the repo; no real `.env` on disk or in history |

---

## PRE-LAUNCH SECURITY CHECKLIST

**Secrets & keys**
- [FAIL] No hardcoded backdoor credential accepted in production (Finding 1)
- [FAIL] No database/credential material in git history (Finding 2) — requires history rewrite + rotation
- [PASS] `.env*` real files ignored; only placeholders committed
- [PASS] No API keys/tokens/private keys in repo or history (pattern scan + git log review)
- [NEEDS MANUAL REVIEW] Screenshots in `images/` for embedded PII (Finding 16)

**Authentication**
- [FAIL] Login brute-force protection (Finding 3)
- [PASS] Server-side identity resolution; no client-supplied `customerId` trust
- [PASS] Secure HttpOnly SameSite session cookie; server-side session store with TTL + revocation
- [FAIL] Session secret enforced in production (Finding 6)
- [FAIL] Account enumeration eliminated (Finding 7)
- [PASS] No OAuth (not implemented — nothing to review)
- [NEEDS MANUAL REVIEW] Password policy if a real signup flow is added (Finding 14)

**Authorization**
- [PASS] Ownership enforced server-side for orders/refunds/tickets (IDOR test — see below)
- [PASS] Admin endpoints role-gated at route AND in lib functions
- [FAIL] `update_support_ticket` dual-layer staff check (Finding 10)
- [PASS] Internal tool (`process_refund`) unreachable via any tool path

**Database**
- [PASS] Parameterized queries only (Drizzle, static identifiers)
- [PASS] Tenant isolation via `customerId` scoping in every handler
- [NEEDS MANUAL REVIEW] Supabase/Postgres: confirm `DATABASE_URL` uses the direct (not public) connection string, DB not publicly reachable, and that direct-connection usage (no RLS reliance) is intended — the app authenticates with the connection-string credentials server-side only (client never sees them); verify in the Supabase console (network access, pooler mode)
- [FAIL→note] SQLite file perms on Linux hosts (Finding 13) — N/A if deploying to Postgres

**API security**
- [PASS] Every sensitive route requires auth + role (inventory: login, logout, me, chat, chat/history, status, approvals, approvals/[id]/decision, audit, tickets, tickets/[id])
- [PASS] Zod validation on all untrusted parameters
- [FAIL] Rate limiting: login (Finding 3), chat/LLM spend (Finding 11)
- [PASS] No SSRF surface (the only outbound call is the LLM API to a server-configured base URL; no user-controlled URLs)

**Input & injection**
- [PASS] No SQLi (bound values only); no XSS sinks; no command/template/path-traversal vectors
- [PASS] Error surfaces mostly structured (exception: Finding 9)

**Frontend trust boundary**
- [PASS] All permission checks re-enforced server-side; nothing security-relevant in client JS; no privileged creds in bundle

**Admin routes**
- [PASS] `/admin` data APIs admin-gated; `/support` staff-gated; approval execution double-checked in lib
- [PASS] No way for a customer to invoke admin actions via the chat tool path (visibility + authorize + handler checks)

**Security configuration**
- [FAIL] Security headers (Finding 8)
- [PASS] Cookie flags; CORS default-deny; no debug in prod
- [FAIL] 500 error hygiene (Finding 9)

**Dependencies**
- [FAIL] Next.js unpatched (Finding 4)
- [FAIL] drizzle-orm HIGH advisory (Finding 5)
- [PASS] Production-only dep set is small (9 packages, all well-known)
- [PASS] No CI/CD workflows exist to audit (nothing unsafe to review) — add CI with `npm audit` + tests

**Logging & monitoring**
- [PASS] Audit trail covers auth-gated actions, approvals, refunds, ticket ops; secrets redacted
- [NEEDS MANUAL REVIEW] Alerting: no monitoring for failed-login spikes, approval anomalies, or LLM spend — wire audit logs to an alerting sink before launch

**Production configuration**
- [FAIL] Fail-fast when running in production with demo/mock defaults (Finding 1/6 — currently the app silently runs with `demo1234` backdoor + mock LLM + SQLite)
- [PASS] Env separation exists (`.env.test` test-only; `.env.local` ignored)
- [NEEDS MANUAL REVIEW] Deployment target specifics (TLS termination, host firewall, DB exposure)

---

## ATTACKER TEST (documented, not executed against live systems)

**A) Unauthenticated**
| Attempt | Result |
|---|---|
| Read any `/api/*` data | BLOCKED — all data routes return 401 without cookie (verified in code: `currentPrincipal()`/`requireRole` first) |
| Brute-force login | POSSIBLE — no rate limit (Finding 3) |
| Log in as any user incl. admin | **POSSIBLE — `demo1234` backdoor (Finding 1)** |
| Frame the app (clickjacking) | POSSIBLE — no XFO/frame-ancestors (Finding 8) |

**B) Authenticated normal customer**
| Attempt | Result |
|---|---|
| Read own orders/tracking/ticket/history | ALLOWED (intended) |
| Request refund on own order | ALLOWED, approval-gated, idempotent, amount-capped at refundable balance |
| Open ticket on own account | ALLOWED (intended) |
| Read staff/admin endpoints | BLOCKED — 403 (tickets, audit, approvals, decisions) |
| Spam LLM spend | **POSSIBLE — no throttle (Finding 11)** |

**C) Malicious user targeting another user's data**
| Attempt | Result |
|---|---|
| `get_order` / `get_tracking_status` with foreign order id (e.g., `ORD-9999`) | BLOCKED — NOT_FOUND, existence not leaked (`findOrderFor`) |
| `request_refund` on foreign order | BLOCKED — NOT_FOUND (ownership) |
| `request_refund` with `customerId` = victim | BLOCKED — FORBIDDEN (`resolveRefundCustomer`) |
| `create_support_ticket` with `customerId` = victim | BLOCKED — FORBIDDEN (`resolveTicketCustomer`) |
| `update_support_ticket` on any ticket via chat | BLOCKED today (tool not in customer's visible set) — **single-layer only (Finding 10)** |
| Read victim's chat history / status / approvals | BLOCKED — all self-scoped by server-injected principal |
| Direct HTTP with changed IDs on data routes | BLOCKED — no route accepts arbitrary user ids (history/status take none) |

**Bottom line of the attacker test:** object-level authorization on the data path is genuinely solid; the exploitable paths are the **authentication layer** (backdoor + brute force + no rate limits) and the **availability/economic** layer (LLM spend), plus the **leaked repo history**.

---

## TOP 5 THINGS TO FIX BEFORE LAUNCH

1. **Remove the `demo1234` universal password backdoor and demo account scaffolding from production** (Finding 1, [auth.ts:16,30](src/lib/auth.ts#L16)). This alone is launch-blocking: it hands admin to anyone. Add a production boot-time check that refuses to start with demo defaults, and require real credential provisioning (or SSO).
2. **Purge the committed SQLite WAL/SHM files from git history and rotate** (Finding 2): `git filter-repo` or fresh repo, fix `.gitignore` (`*.db-wal`, `*.db-shm`, `data/`), revoke all sessions, re-seed with new passwords. If the repo was ever pushed anywhere, treat hashes/sessions as public. Removing the files at HEAD is not sufficient — history retains them.
3. **Upgrade the framework SQL/web stack: `next@^15.5` and `drizzle-orm@>=0.45.3`** (Findings 4–5), then re-run the full verification suite (typecheck, lint, 86 tests, build, E2E) under Node v24.19.0. Next 15.1.6 carries unpatched critical-range advisories (incl. Windows RCE); drizzle's HIGH advisory sits in your SQL layer even if not currently exploitable.
4. **Add rate limiting + failure alerting to `/api/auth/login`, and a per-session cost/turn cap to `/api/chat`** (Findings 3, 11). These are the only remaining paths to account takeover (post-#1) and the only paths to economic/availability abuse of your LLM spend.
5. **Harden session/config baseline: enforce `SESSION_SECRET` (fail fast), stop leaking internal error messages, add security headers (CSP/XFO/HSTS/nosniff), and unify the login error text** (Findings 6–9). Small, low-risk changes that close the configuration and information-disclosure gaps before any real user touches the system.

---

## Still requires manual penetration testing / production verification

- **Live HTTP pass** against a deployed instance: IDOR replay with real session cookies (the code-level checks are verified, but a black-box pass on `/api/chat` tool args, `/api/approvals/:id/decision`, and `/api/tickets/[id]` with tampered ids is still warranted).
- **Prompt-injection campaign** against the *real* OpenAI planner (only the mock planner is deterministic; test whether injected text can coerce staff-tool proposals — the loop should deny them, but verify empirically, especially staff accounts reading user-submitted ticket content).
- **Supabase production check**: network exposure, connection-string role (direct vs pooler), whether any Supabase APIs (PostgREST/Storage) are enabled for this schema, and that the app's Postgres adapter was run against a real instance (README itself marks this unverified).
- **Load/abuse test** on `/api/chat` and login under your actual rate-limit implementation, plus LLM spend alerting thresholds.
- **Windows host deployment specifics** (given the Windows-RCE Next advisory and your dev platform): confirm the post-upgrade Next version on the target server, file permissions for `data/`, and reverse-proxy/TLS configuration.
- **Secret-scanning in CI** (gitleaks) going forward, and periodic `npm audit` gates.
