# TECHNICAL HANDOVER — Aurora Support (AI Customer Support Agent)

- **Date of assessment:** 2026-09-23
- **Method:** Full source inspection of the working tree + execution of the repository's own verification commands (vitest, tsc, next lint, next build, Playwright E2E) + read-only database inspection. No source files were modified during this assessment.
- **Repository state at assessment:** branch `dev`, 5 commits (`71a9c9e` … `7a96ca8`), remote `origin` → `github.com/Karan7505/AI-Customer-Support-Agent.git`, **dirty working tree** — an uncommitted security-hardening pass (see §17 and git status output recorded in §25) plus 5 new untracked files. The handover describes the **working tree as it exists on disk**, which is what tests/builds actually run against.
- **Verification runtime:** Node **v24.19.0** (verified via `node -v`). This is the user's runtime; the project's `package.json` declares `engines.node >= 22` and pins `better-sqlite3 ^13.0.3` (a native module that must match the Node ABI — do not run it under an unrelated Node major version).
- **Status legend used throughout:** VERIFIED · IMPLEMENTED BUT NOT RUNTIME-VERIFIED · MOCK/FALLBACK · PARTIALLY IMPLEMENTED · CONFIGURED BUT REQUIRES EXTERNAL CREDENTIALS · PLACEHOLDER/STUB · NOT IMPLEMENTED · UNKNOWN / CANNOT VERIFY

---

## 1. EXECUTIVE SUMMARY

**What it is.** "Aurora Support" is a single-process **Next.js 15 (App Router) + TypeScript** web application that implements an **agentic AI customer-support system** for a fictional e-commerce business ("Aurora"). It is one deployable unit: React frontend pages, a REST-style JSON API (`src/app/api/**`), an LLM-driven agent loop, a permission/risk engine, a human-in-the-loop approval workflow, and a database layer.

**The problem it solves.** A support assistant that can *do* things, not just talk: look up orders and (mock) tracking, open support tickets, and initiate refunds — with the hard safety property that **the LLM only ever *proposes* a tool call; every authorization, risk-classification, validation, approval, and money-moving decision is made by deterministic TypeScript code** (`src/lib/agent.ts`, `policy.ts`, `tools.ts`, `refunds.ts`, `approvals.ts`). This "the model proposes, the app disposes" split is the architectural centerpiece and is the main design rationale evidenced throughout the code (doc comments in `agent.ts:23-35`, `llm.ts:3-9`, `openai.ts:8-12`).

**Intended users (three roles, all in one `customers` table):**
- **customer** — chats about their own account (orders, tracking, tickets, refund requests).
- **support_agent** — staff workspace in the same chat plus a ticket dashboard (`/support`): search customers, view any order/ticket, file/update tickets, initiate refunds *for* a customer. Cannot approve/execute.
- **admin** — everything above, plus the approval console and audit log (`/admin`).

**Primary use cases / main workflows (all VERIFIED by tests and/or E2E):**
1. Customer asks "Where is order ORD-1001?" → agent calls `get_order` + `get_tracking_status` → order/tracking card.
2. Customer asks "Refund my last order" → agent lists orders, checks ownership/eligibility/amount/duplicates → creates an **approval request** (`APR-…`) + a `pending_approval` refund row. **Nothing is refunded.**
3. Admin opens `/admin` → reviews the pending approval with full context → Approve/Reject. Approve → refund executes **exactly once**, transactionally, idempotently; order balance decremented; all steps in the audit log.
4. Customer "item arrived damaged" → ticket auto-created with derived subject/priority. Support agent works tickets on `/support` (status, priority, internal notes).
5. Policy questions ("What is your return policy?") → answered from a static, cited knowledge base (`src/lib/knowledge.ts`).

**Maturity — evidence-based classification: production-oriented MVP / demo, NOT a production system.**
- For: real typed codebase, dual-database driver design, 102 passing unit/integration/eval tests, 2 passing browser E2E specs, production build, a completed security-audit + remediation pass (`SECURITY_AUDIT.md`), fail-closed production boot gate, rate limiting, security headers.
- Against: **no CI/CD, no Dockerfile, no observability stack** (no metrics/tracing/health endpoint beyond `next` defaults), the LLM is **mock by default** (OpenAI integration exists but has never been run with a real key — README says so explicitly), the Postgres/Supabase path is implemented but never run against a live instance (README says so explicitly), **no user registration** (accounts are seeded only), **no real payment/refund provider** (refunds decrement a DB column — no money actually moves), tracking is synthesized in code, no email/notification delivery, and the working tree has uncommitted changes with 5 commits total.
- Verdict: a high-quality, well-tested **reference architecture / MVP**. It is safe to iterate on and close to "real", but operating it as a live production service requires the gap items in §31 (credentials, deployment tooling, real providers, operational tooling).

**Most important technical characteristics:**
- One Node process serves UI + API + agent + DB access. SQLite (better-sqlite3) by default; Postgres via `DATABASE_URL`. Mock LLM by default; OpenAI-compatible function calling when a key is set. No other infrastructure required to run.
- Money is **integer cents**; time is **epoch ms** (schema convention, `.db/schema.sql:2`).
- Every external dependency is optional by environment variable — the app is deliberately runnable with zero configuration.

**Most important limitations:**
- **No real external integrations are live-verified** (OpenAI, Postgres both CONFIGURED BUT REQUIRES EXTERNAL CREDENTIALS).
- **No horizontal scaling story**: in-process rate-limit state, SQLite single-writer file, single process (details in §22).
- **No registration flow**: you cannot create an account through the product; accounts are seed data.
- **Refunds are simulated** (DB state), and **tracking is synthesized** from order data — both are explicit mocks, clearly labeled in code.
- **No CI/CD or container packaging** — deployment is "copy the repo, npm install, build, run".

---

## 2. PRODUCT / FUNCTIONAL OVERVIEW

All routes are under one Next.js app. Routes are VERIFIED against the build output (`next build` route table, §25) and source.

### 2.1 Authentication

- **Registration: NOT IMPLEMENTED.** There is no sign-up endpoint, page, or repo method to create users. Accounts exist only via `src/db/seed.ts` (seeded demo accounts, VERIFIED by reading the seed and by read-only DB inspection: 5 customers in `data/app.db`).
- **Login:** `POST /api/auth/login` (Zod-validated email+password). Server-side: lookup by email → PBKDF2 verify (or dev-only demo-password path) → create session row + set cookie. Brute-force throttled (8/10min per IP **and** per account). Entry point: `/login` page with email/password form; in non-production builds it also shows quick-login buttons for the 4 demo accounts.
- **Logout:** `POST /api/auth/logout` — requires a JSON body (CSRF mitigation), revokes the session row, clears the cookie.
- **Session check:** `GET /api/auth/me` — 401 `{user:null}` or 200 `{user:{id,name,email,role}}`.
- **Status:** VERIFIED (unit tests, E2E logins, production smoke).
- **Failure behavior:** wrong credentials → identical 401 message for unknown email vs wrong password (no enumeration); rate-limited → 429; all pages redirect to `/login` on 401.

### 2.2 Customer chat (AI agent) — `/chat`

- **What it does:** Conversational support. One persistent conversation per customer (`conversations` table, created lazily). Every user message runs the full agent loop (LLM plan → validated, authorized, risk-checked tool execution → final answer).
- **Inputs:** free text (1–4000 chars). **Outputs:** assistant text + structured "cards" (order card with tracking timeline, ticket card, refund/approval card) + a read-only tool-trace strip.
- **Feature list (all VERIFIED unless noted):**
  - Order lookup by ID and "my orders" listing (`get_order`, `list_customer_orders`)
  - **Mock tracking** (`get_tracking_status`) — tracking events are **synthesized deterministically** from order status/createdAt in `tools.ts mockTracking()` (MOCK/FALLBACK, clearly commented)
  - Support ticket creation with derived subject + priority (`create_support_ticket`)
  - **Return requests** route into the refund flow; **cancellation requests** open a cancellation ticket (implemented in the mock planner's intent detection, `mock.ts`)
  - Refund requests → approval workflow (§2.4)
  - Policy Q&A from the static KB (`lookup_policy`, 7 entries, cited)
  - "Awaiting approval" banner when the customer has a pending refund
- **Failure behavior:** API error → inline assistant bubble "Something went wrong: …"; 429 rate-limit → same; LLM timeout (60s) → generic tool error reported by the agent.
- **Roles:** served to all roles; staff get a staff-scoped toolset server-side (same page).

### 2.3 Support desk dashboard — `/support` (staff)

- **What it does:** Ticket queue for `support_agent` + `admin`: filterable list (status), ticket detail (subject, description, customer, linked order), change status/priority via dropdowns, append **internal notes** (agent-only thread, stored as JSON in the ticket row).
- **Entry:** server-side RSC layout gate (redirects unauthenticated → `/login`, non-staff → `/chat`) **plus** client-side `/api/auth/me` check **plus** API-level role checks (three layers, VERIFIED by code + E2E customer-lockout step).
- **VERIFIED** by `support-dashboard.spec.ts` (login → see seeded ticket TCK-1001 → change status → add note → persists → customer redirected away).

### 2.4 Admin console — `/admin` (admin)

- **What it does:** Two tabs:
  - **Approvals:** pending/all approval requests with requester, order context, amount, risk level, reason; **Approve** (optionally with reject reason). Approving **immediately executes** the bound action (refund) in the same request.
  - **Audit log:** last N audit entries (actor, action, tool, result JSON).
- **Entry:** same three-layer protection as `/support`, admin-only.
- **VERIFIED** by `core-flow.spec.ts` (approve → refund executed → customer sees "refunded").

### 2.5 Refund / approval workflow (the core business capability)

- Customer (or staff on a customer's behalf) requests a refund → ownership, status-eligibility, amount, and duplicate checks → **approval request created** (bound to exact arguments via idempotency key; TTL 72h default, auto-expires on read) → admin decides → on approve, `executeApprovedAction` runs the **internal, transactional, idempotent** refund executor.
- **No code path can execute a refund without a valid approval** (`process_refund` is an internal tool: not in the LLM schema, denied by `authorize()`, handler role-checked admin-only). VERIFIED by unit + integration + eval tests (including "retry same approved refund → idempotent, no double decrement").
- **The "refund" is simulated**: it updates `refunds.status` and decrements `orders.refundable_amount`. There is **no payment provider integration** (NOT IMPLEMENTED — see §13, §31).

### 2.6 Background operations, automation, realtime, uploads, search, billing, analytics

- **Background jobs/queues:** NOT IMPLEMENTED (no worker, no queue; approval execution is synchronous inside the admin's HTTP request).
- **Realtime/WebSockets:** NOT IMPLEMENTED (no socket code; UI polls via fetch on page load / after actions).
- **File uploads/downloads:** NOT IMPLEMENTED (no upload route, no storage).
- **Notifications/email:** NOT IMPLEMENTED (README mentions "we will send a prepaid label" in policy text, but no delivery mechanism exists).
- **Search:** customer search (staff tool, `search_customers`), order/ticket filtered listings — all DB `LIKE`-based (VERIFIED in `repos.ts`).
- **Billing/payments:** none (refund simulation only).
- **Analytics:** none (audit log is the only telemetry, admin-visible).
- **Automation:** none (no cron, no instrumentation beyond boot checks).

---

## 3. USER JOURNEYS / END-TO-END FLOWS

### 3.1 Golden path: order lookup → refund request → admin approval → executed refund

VERIFIED end-to-end by `tests/e2e/core-flow.spec.ts` (executed in this assessment, §25).

```mermaid
sequenceDiagram
    participant C as Customer (browser /chat)
    participant API as Next.js API (nodejs runtime)
    participant AG as Agent loop (lib/agent.ts)
    participant LLM as LLM planner (mock | openai)
    participant T as Tools (lib/tools.ts)
    participant DB as SQLite/Postgres (repos.ts)
    participant A as Admin (browser /admin)

    C->>API: POST /api/auth/login
    API->>DB: getCustomerByEmail + PBKDF2 verify
    API->>DB: INSERT sessions
    API-->>C: 200 + Set-Cookie support_session (HttpOnly, SameSite=Lax)

    C->>API: POST /api/chat {message:"Refund my last order"}
    API->>DB: sessions lookup → principal (server-injected, never from client)
    API->>AG: runTurn(principal, text)
    AG->>DB: getOrCreateConversation + addMessage(user)
    loop ≤ AGENT_MAX_ITERATIONS (6)
        AG->>LLM: plan(messages, tools visible for role)
        LLM-->>AG: {tool:"list_customer_orders"} | {tool:"request_refund",args}
        AG->>AG: known? → zod validate → authorize(role) → getRiskLevel
        AG->>T: runTool (owner/eligibility/amount/dup checks)
        T->>DB: reads + INSERT approval_requests + INSERT refunds(pending_approval)
        T-->>AG: {ok, data:{status:"pending_approval", approvalId}}
        AG->>LLM: tool result as message
    end
    AG->>DB: addMessage(assistant, meta{cards,events}) + audit agent.turn_complete
    AG-->>API: assistantText + cards + events
    API-->>C: 200 {assistant, cards, events}  (UI shows "pending approval" card + banner)

    A->>API: POST /api/approvals/:id/decision {approve:true}
    API->>DB: requireRole(admin) → getApproval (TTL check → maybe expired)
    API->>AG(approvals.ts): decideApproval → status=approved
    API->>AG(approvals.ts): executeApprovedAction
    Note over AG,DB: TRANSACTION: complete refund row + decrement order balance<br/>idempotent via refunds.idempotency_key (unique)
    API-->>A: 200 {approval, refund}
```

### 3.2 Customer reads chat history on page load

`/chat` mount → `GET /api/auth/me` (401 → redirect `/login`) → `GET /api/chat/history` (own conversation's user/assistant messages + stored cards/events meta) → `GET /api/status` (own approvals + refunds, drives the "awaiting approval" banner). All VERIFIED in `chat/page.tsx`.

### 3.3 Support agent works a ticket

Login → `/support` (layout gate) → `GET /api/tickets?status=…` (list, enriched with customer names) → click → `GET /api/tickets/:id` (ticket + customer + linked order) → dropdown/select or note → `POST /api/tickets/:id {status|priority|note}` → audit entry (`ticket.updated` / `ticket.note_added`) → list + detail re-render. VERIFIED by `support-dashboard.spec.ts`.

### 3.4 Policy question

"what is your return policy?" → mock planner detects question + KB match → `lookup_policy` tool → `knowledge.ts lookupPolicy()` keyword scoring → answer + citation rendered. With a real LLM the model may answer from the system prompt or call `lookup_policy`; both paths are safe (KB is general policy only). VERIFIED by Eval 10.

### 3.5 Cross-customer access attempt (negative flow)

Customer asks about another customer's order → `get_order` returns **NOT_FOUND** (not FORBIDDEN) so existence is not leaked. Customer tries `request_refund`/`create_support_ticket` with someone else's `customerId` → FORBIDDEN. Staff may cross customers; the target customer is always a real, existing, `role=customer` account. VERIFIED by Eval 2 + staff-chat evals + integration tests.

---

## 4. COMPLETE TECHNOLOGY STACK

Exact versions from `package.json` (recorded in §25). Reason for each choice is given where the code/README provides evidence; otherwise marked as inferred.

| Layer | Technology (version) | Why it's here (evidence) |
|---|---|---|
| Language | TypeScript 5.7.3, `strict: true` (tsconfig) | Whole codebase is TS; `tsc --noEmit` is a first-class script. |
| Runtime | Node.js `>=22` (package.json engines); verified working on **v24.19.0** | `better-sqlite3 ^13.0.3` requires a matching Node ABI (Node 24 → ABI 137). |
| Framework (UI+API) | Next.js `^15.5.25` App Router | Single process serves pages + route handlers; all API routes set `export const runtime = "nodejs"` (needed for better-sqlite3 + async work). |
| UI | React 19.0.0 / react-dom 19.0.0 | Client components for pages; one shared `src/components/status.tsx`. |
| Styling | Tailwind CSS 3.4.17 + PostCSS 8.4.49 + Autoprefixer 10.4.20; `globals.css` with custom utility classes (`.card`, `.input`, `.btn-primary`, …); Google Fonts (Inter, JetBrains Mono) via `next/font` | Standard Next.js Tailwind setup. |
| Icons | lucide-react 0.469.0 (dep) | Imported by pages (e.g. header icons). |
| Class utility | clsx 2.1.1 | Conditional className joining. |
| Database (default) | SQLite via better-sqlite3 ^13.0.3 (native, synchronous) wrapped behind an async repo | Zero-config local dev/offline mode (README, `client.ts`). |
| Database (alt) | Postgres via `postgres` (postgres-js) ^3.4.9 | Supabase support via `DATABASE_URL` (README, `client.ts`, `.db/schema.pg.sql`). |
| ORM/query layer | Drizzle ORM ^0.45.3 (better-sqlite3 + postgres-js drivers) | Schemas in `src/db/schema.ts` / `schema.pg.ts`; queries in `repos.ts`. |
| Schema/migrations | Hand-written idempotent DDL (`.db/schema.sql`, `.db/schema.pg.sql`) applied by `src/db/migrate.ts`; drizzle-kit 0.30.1 present in devDeps | Migrations are "apply DDL once" — no versioned migration framework (drizzle-kit appears unused by scripts — see §30). |
| Validation | Zod 3.24.1 | Every API body and every tool input is Zod-parsed (`.strict()` tool schemas). |
| LLM (real) | OpenAI-compatible **chat/completions + tool_calls via global fetch** (no SDK; `openai.ts`) | Chosen to work with any OpenAI-compatible endpoint (README: vLLM, OpenRouter). |
| LLM (mock) | Deterministic regex/state-machine "planner" (`mock.ts`) | Full workflows reproducible offline with no key (README, code comments). |
| Auth | Hand-rolled cookie sessions: PBKDF2-SHA256 (600k iters) password hashing, 128-bit random session tokens + HMAC signature, `sessions` DB table, 7-day TTL (`auth.ts`, `security.ts`) | No external IdP. |
| Rate limiting | In-process fixed-window limiter (`lib/rate-limit.ts`) | No external cache; documented as single-server only. |
| Testing | Vitest ^3.2.7 (unit/integration/eval), Playwright `@playwright/test` ^1.63.0 (E2E, chromium), jsdom 26.0.0 (devDep; vitest env is "node" — jsdom currently unused by test config) | See §19. |
| Build tooling | Next.js built-in (webpack/turbopack per Next 15); tsx 4.19.2 to run TS scripts (migrate/seed) | `npm run db:*` uses tsx. |
| Lint/format | ESLint 8.57.1 + eslint-config-next 15.1.6 via `next lint` (deprecated in Next 16 — warning observed); **no formatter configured** (no Prettier) | |
| CI/CD | **NOT IMPLEMENTED** — no `.github/` or other CI config in the repo | |
| Containers | **NOT IMPLEMENTED** — no Dockerfile/docker-compose | |
| Observability | None (no metrics/tracing/APM/health endpoint). Logging = `console.*` + app-level `audit_logs` table | |
| Queues/workers/caching/search/vector DB | None | |

**Outdated/conflicting/duplicated items observed (evidence-based):**
- `eslint-config-next 15.1.6` while `next` is `15.5.25` — version drift (cosmetic; lint runs clean).
- `@types/node 20.17.10` while running Node 24 — type definitions a couple of majors behind (works; could cause subtle type gaps).
- `jsdom` devDep is not referenced by `vitest.config.ts` (environment: "node") — likely vestigial.
- `drizzle-kit` devDep is not used by any npm script (migrations are hand-rolled DDL) — likely kept for schema generation convenience.
- `allowScripts` in package.json whitelists several esbuild versions — a host-environment accommodation, not a standard field.
- `next lint` deprecation warning (to be replaced by ESLint CLI in Next 16) — recorded during this assessment's lint run.
- `.env.test` is committed but **not loaded by anything** (vitest uses `tests/setup.ts`; Playwright uses its own `env` block) and points at `./data/test-e2e.db`, which differs from the e2e config's `./data/e2e.db` — stale artifact (see §29).

---

## 5. REPOSITORY STRUCTURE

Top level (verified by directory listing):

```
.db/                    # hand-written idempotent DDL (source of truth for migrations)
  schema.sql            #   SQLite
  schema.pg.sql         #   Postgres/Supabase (camelCase columns)
data/                   # local SQLite files (git-ignored): app.db (dev), e2e.db (test)
images/                 # 8 README screenshots (login, chat, order, tracking, refund,
                        #   staff orders, admin approval pending/approved)
src/
  instrumentation.ts    # Next.js boot hook: production fail-closed checks (see §14/§17)
  app/                  # Next.js App Router (pages + API routes in one tree)
    layout.tsx          #   root layout (fonts: Inter + JetBrains Mono, metadata)
    page.tsx            #   "/" → redirect("/chat")
    globals.css         #   Tailwind + custom utility classes
    login/page.tsx      #   sign-in (client component)
    chat/page.tsx       #   agent chat, all roles (client component, 375 lines)
    admin/layout.tsx    #   server-side auth+role gate (admin)
    admin/page.tsx      #   approvals + audit console (client component)
    support/layout.tsx  #   server-side auth+role gate (staff)
    support/page.tsx    #   ticket dashboard (client component, 437 lines)
    api/                # all JSON endpoints (each: runtime="nodejs")
      _util.ts          #   shared: json(), httpError(), requireRole(), cookie helpers,
                        #   currentPrincipal(), clientIp(), deps()
      auth/{login,logout,me}/route.ts
      chat/route.ts  chat/history/route.ts
      approvals/route.ts  approvals/helpers.ts  approvals/[id]/decision/route.ts
      status/route.ts  audit/route.ts
      tickets/route.ts  tickets/[id]/route.ts
  components/
    status.tsx          # shared status→label/tone maps + StatusPill
  db/
    schema.ts           # Drizzle SQLite schema (typed) + shared enums (ORDER_STATUS, …)
    schema.pg.ts        # Drizzle Postgres schema (camelCase columns)
    row-types.ts        # driver-agnostic row shapes shared by both repos
    client.ts           # connections: better-sqlite3 / postgres-js; 0600 file perms
    repos.ts            # THE data-access boundary: async Repo interface +
                        # createSqliteRepo() / createPostgresRepo() / getRepo()
    migrate.ts          # applies .db/schema{,.pg}.sql (idempotent; --reset = SQLite)
    seed.ts             # seeds 5 accounts / 6 orders / tickets / approvals (--force)
  lib/                  # framework-agnostic core (no React, no Next imports)
    env.ts              # typed env access + runtime-mode banner + prod boot asserts
    agent.ts            # the controlled agent loop (288 lines)
    llm.ts              # LlmClient interface + LlmPlan types + system prompt builder
    llm-factory.ts      # mock|openai auto-select
    mock.ts             # deterministic offline planner (706 lines of regex/state logic)
    openai.ts           # OpenAI-compatible planner (fetch, 60s timeout)
    policy.ts           # authorize(), getRiskLevel(), visibleToolsFor(), isStaff()
    tools.ts            # tool registry + handlers + runTool() (666 lines)
    schemas.ts          # Zod input/output schemas (strict)
    knowledge.ts        # 7-entry static policy KB + keyword matcher
    refunds.ts          # eligibility rules + idempotency keys (pure functions)
    refund-execution.ts # transactional, idempotent refund executor (admin-only)
    approvals.ts        # approval state machine + create/decide/execute
    audit.ts            # auditor with secret-redaction
    auth.ts             # login/logout/getPrincipal, session tokens + HMAC signature
    security.ts         # PBKDF2 (600k), randomToken, safeEqual, hmacSign
    rate-limit.ts       # in-process fixed-window limiter
    ids.ts              # CSPRNG id generator (genId → "TCK-5231ab3c")
    errors.ts           # AppError + Errors.* factories (stable codes)
    types.ts            # shared domain types (Principal, Order, Ticket, Refund, …)
    util.ts             # nowMs, parseJson, toJson, formatCents
    client.ts           # frontend fetch helper (api(), ApiError, formatters)
tests/
  setup.ts              # vitest env (mock LLM, :memory: DB)
  helpers.ts            # makeEnv(): in-memory SQLite + repo + fixtures (4 principals, 3 orders)
  unit/                 # 8 files: policy, validation, refund-eligibility, approval-state,
                        #   tool-routing, security-hardening
  integration/          # 3 files: orders, tickets, refund-flow
  eval/                 # 2 files: agent-eval (18 scenarios), staff-chat (8 scenarios)
  e2e/                  # 2 Playwright specs: core-flow, support-dashboard
SECURITY_AUDIT.md       # pre-launch audit (16 findings) + remediation status table
TECHNICAL_HANDOVER.md   # this document
README.md               # product + setup + architecture docs (554 lines; see §29 for deltas)
```

**Entry points (verified):**
- Frontend: `src/app/layout.tsx` (root) → pages listed above.
- Backend: every `src/app/api/**/route.ts` (App Router route handlers). The app has **no custom server** (`next dev` / `next start` only).
- Boot: `src/instrumentation.ts` `register()` runs before the server accepts traffic.
- DB bootstrap: `src/db/migrate.ts` / `src/db/seed.ts` (run via tsx).

**Module relationships:** `app/api/*` → `lib/*` (agent, auth, approvals, audit) → `db/repos` (async Repo) → `db/client` (driver) → SQLite/Postgres. The `lib/` core is deliberately Next.js-free so it runs under vitest with an in-memory DB. UI → `/api/*` only (no direct DB access from the client; all trust decisions server-side).

---

## 6. SYSTEM ARCHITECTURE

```mermaid
flowchart TB
    subgraph Browser
        L[/login/] --> C[/chat/ all roles]
        C --> S[/support/ staff gate/ RSC layout]
        C --> A[/admin/ admin gate/ RSC layout]
    end

    subgraph "Next.js process (single Node.js service, nodejs runtime)"
        UI[React client components<br/>fetch + cookie auth]
        subgraph API[API routes src/app/api]
            AUTH[auth: login/logout/me<br/>cookie sessions + HMAC tokens]
            CHAT[POST /api/chat<br/>rate limit → agent loop]
            HIS[GET /api/chat/history]
            APPR[approvals list/decision<br/>admin role check]
            TIK[tickets list/update<br/>staff role check]
            ST[GET /api/status · GET /api/audit]
        end
        subgraph CORE[lib/ — deterministic core]
            AGENT[agent.ts loop<br/>≤6 iterations, dedupe guard]
            POL[policy.ts<br/>authorize + risk]
            TOOLS[tools.ts registry<br/>Zod-validated handlers]
            REF[refunds.ts rules<br/>refund-execution.ts tx executor]
            APR2[approvals.ts state machine]
            AUD[audit.ts redacting auditor]
        end
        LLMF[llm-factory<br/>mock | openai by env]
        DBR[db/repos.ts<br/>async Repo interface]
    end

    LLMF -.->|OPENAI_API_KEY| OAI[OpenAI-compatible API]
    DBR -->|default| SQ[(SQLite file<br/>data/app.db<br/>better-sqlite3, 0600)]
    DBR -->|DATABASE_URL set| PG[(Postgres/Supabase<br/>postgres-js)]

    UI --> API
    API --> CORE
    AGENT --> LLMF
    TOOLS --> DBR
    APR2 --> DBR
    AUD --> DBR
```

**Architecture description and rationale (evidence-based):**

- **Single service, no service boundaries.** UI, API, agent, and data access run in one Node process. Evidence: no custom server, no queues, no separate API deployment; README states this explicitly and the code confirms it. Rationale (inferred, consistent with evidence): keep the reference implementation deployable anywhere Node runs, with zero infrastructure.
- **The agent loop is the trust core** (`agent.ts`). Every LLM-proposed tool call passes, in application code: known-tool check → duplicate-call guard → `authorize(principal)` → `getRiskLevel()` → Zod-validated execution (`tools.ts` via `runTool`) → audit log. High-risk outcomes create approval requests instead of executing. Tool *results* are structured JSON appended as `tool` messages; the LLM never sees internal tools (`visibleToolsFor` strips them). Rationale is stated in code comments: "The planner NEVER performs authorization, risk, or business rules" (`llm.ts:6-8`).
- **Two trust boundaries:** (1) browser ↔ API — cookie session, server-injected principal (the client never supplies identity), role checks on every route; (2) LLM ↔ app — all LLM output treated as untrusted input (system prompt says so explicitly; injection handled by the deterministic gates, proven by Eval 4).
- **Persistence is behind one interface.** `Repo` (async) with two implementations over the same tables; `getRepo()` picks the driver from `DATABASE_URL`. Monetary values integer cents; timestamps epoch ms.
- **State:** all state is durable in the DB (sessions, conversations, messages, tickets, refunds, approvals, audit). The only in-memory state is the rate limiter (documented single-server limitation) and the single DB connection handle per process.
- **No background processing:** approval execution happens synchronously inside the admin's decision request; nothing is scheduled.

**Why designed this way (establishable from evidence):** the stated goal is a *safe agentic* system ("the model is never trusted with authorization, ownership, or money" — README + code comments), so the architecture pushes every decision into deterministic, unit-testable TypeScript with the LLM as a swappable, untrusted component. The dual-driver + mock-LLM design makes the entire workflow testable and demonstrable offline (both verified by the test suite).

---

## 7. FRONTEND ARCHITECTURE

- **Framework/mode:** Next.js App Router; all five pages are client components (`"use client"`) except the root layout, the landing redirect, and the two server-component auth gates (`admin/layout.tsx`, `support/layout.tsx`). Styling: Tailwind with a dark custom theme (`globals.css`) plus component classes (`.card`, `.input`, `.btn-primary`, `.chip`, …). No CSS-in-JS, no component library, no state-management library.
- **State management:** plain React `useState`/`useCallback`/`useRef` per page. No Redux/Zustand/context. `src/lib/client.ts` provides the only shared client logic: `api()` fetch wrapper (JSON, throws `ApiError{code,message,status}` on non-2xx) and currency/date formatters.
- **Auth state:** each page resolves identity on mount via `GET /api/auth/me`; on 401 it `router.replace("/login")`. Role drives UI (suggestions, nav links) but **never** enforcement — enforcement is server-side.
- **Routes:**

| Route | Component | Access (server gate) | Notes |
|---|---|---|---|
| `/` | `page.tsx` | public | `redirect("/chat")` |
| `/login` | `login/page.tsx` | public | demo quick-logins only when `NODE_ENV !== "production"` (line 17) |
| `/chat` | `chat/page.tsx` | any authenticated user (client-side) | all roles; cards: `OrderCard` (w/ tracking timeline), `TicketCard`, `RefundCard`; tool-trace strip; awaiting-approval banner |
| `/support` | `support/page.tsx` + layout | RSC layout: staff only, else redirect (VERIFIED in E2E) | two-pane ticket queue + detail; status/priority `<select>`; internal note form |
| `/admin` | `admin/page.tsx` + layout | RSC layout: admin only, else redirect (VERIFIED) | Approvals tab (Approve/Reject + reason) and Audit tab (table) |

- **Forms/validation:** login form (email/password, client-side `busy`/`error` states); chat input (disabled while busy, non-empty check); ticket note form (min 3 chars). No client-side schema validation beyond that — server re-validates everything with Zod.
- **Loading states:** "Loading…" full-screen state on `/chat` until me+history resolve; per-pane spinners/empty states on dashboards; `alert()` for action errors on admin/support pages (naive but functional).
- **Realtime:** none — no websockets, no polling loop; the UI refetches after its own actions and on mount.
- **Client → backend path:** `api(path, init)` → `fetch` with `Content-Type: application/json` → browser sends the HttpOnly session cookie automatically → API route handler → `currentPrincipal()`/`requireRole()` → `lib` core → `Repo`. Response JSON is either `{ok,...}` or `{error:{code,message}}` mapped to `ApiError`.

---

## 8. BACKEND ARCHITECTURE

- **Server entry:** none custom — Next.js serves route handlers. `src/instrumentation.ts register()` is the only boot code (production assertions: missing `SESSION_SECRET` → process exits; mock LLM in production → loud warning).
- **Request pipeline (per API route):** route handler → `currentPrincipal()` (cookie → `sessions` table lookup → HMAC signature check → expiry check → customer row) or `requireRole([...])` → business function in `lib/` → `Repo` call → `json()`/`httpError()`. There is no middleware; each route does its own auth (consistent pattern in `app/api/_util.ts`).
- **Error handling:** domain errors are `AppError` with stable codes; `httpError()` maps code→status (401/403/404/400/409/500) and returns `{error:{code,message,details?}}`. **Non-AppError exceptions are logged server-side (`console.error`) and returned as generic `INTERNAL`** — driver/SQL details never reach the client (VERIFIED in `_util.ts:27-35`).
- **Responsibility boundaries:**
  - `app/api/*` — transport only (parse, auth, shape response). No business rules.
  - `lib/agent.ts` — orchestration only (loop, dedupe, event emission); delegates to policy/tools/approvals.
  - `lib/policy.ts` — pure decision functions (`authorize`, `getRiskLevel`, `visibleToolsFor`, `requiresApproval`, `isStaff`).
  - `lib/tools.ts` — tool registry: per-tool JSON schema + Zod validation + ownership scoping + handler.
  - `lib/refunds.ts` (pure rules) vs `lib/refund-execution.ts` (transactional side effects) — deliberately split so rules are unit-testable without a DB.
  - `lib/approvals.ts` — state machine + decide/execute; execution reads arguments **from the stored approval, never from the caller**.
  - `lib/audit.ts` — single write path for audit entries, with secret-key redaction and 4000-char truncation.
  - `db/repos.ts` — the only place SQL/Drizzle queries exist; async interface hides the sync SQLite driver.
- **Logging:** `console.*` only. `[aurora]`-prefixed lines for mode banner, login failures (email+IP, never password), unhandled errors. No structured logging library, no request IDs.

---

## 9. API INVENTORY

All endpoints are `runtime="nodejs"`. Auth = session cookie (`support_session`). "Role" column = enforced requirement. VERIFIED = exercised by tests/E2E in this assessment.

| # | Method | Route | Purpose | Auth | Role | Input → Output | Validation | Key side effects | File | Error behavior |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | POST | `/api/auth/login` | Sign in, create session | none | any | `{email,password}` → `{ok,user}` + `Set-Cookie` | Zod (email, pw≥4); rate limit 8/10min per IP **and** per account (429) | INSERT `sessions`; `login_failed` console warn on failure | `api/auth/login/route.ts` | 401 generic (no enumeration), 400, 429 |
| 2 | POST | `/api/auth/logout` | Revoke session | any token | self | JSON body required (any) → `{ok}` | JSON body required (400 otherwise — CSRF) | DELETE session row; cookie cleared | `api/auth/logout/route.ts` | 400; idempotent (unknown token → ok) |
| 3 | GET | `/api/auth/me` | Current principal | required | self | — → `{user}` | — | — (signature+expiry verified) | `api/auth/me/route.ts` | 401 `{user:null}` |
| 4 | POST | `/api/chat` | Run one agent turn | required | any | `{message}` (1–4000) → `{ok,assistant,cards,structured,events}` | Zod; per-customer rate limit (default 60/10min → 429) | user+assistant message INSERT, tool side effects (tickets/refunds/approvals/audit), conversation auto-create | `api/chat/route.ts` | 401, 400, 429, tool-level errors surfaced as assistant text |
| 5 | GET | `/api/chat/history` | Own conversation messages | required | self | — → `{messages[]}` (user/assistant only, meta parsed) | — | none | `api/chat/history/route.ts` | 401 |
| 6 | GET | `/api/approvals` | List approval requests | required | admin/support | `?status=` → `{approvals[]}` (enriched: requester, order) | status filter (app-side) | none (support sees **own** requests only — scoping in route) | `api/approvals/route.ts` | 401/403 |
| 7 | POST | `/api/approvals/[id]/decision` | Approve/reject; **approve executes immediately** | required | **admin** | `{approve, reason?}` → `{ok,approval,refund}` | Zod; TTL check (expired → error); state machine check | approval UPDATE; linked refund UPDATE; **refund transaction** on approve; audit | `api/approvals/[id]/decision/route.ts` | 401/403/404/409-family (APPROVAL_NOT_APPROVED/EXPIRED) |
| 8 | GET | `/api/status` | Own approvals + refunds | required | self | — → `{ok,awaitingApproval,approvals,refunds}` | — | none | `api/status/route.ts` | 401 |
| 9 | GET | `/api/audit` | Audit trail | required | **admin** | `?limit=` (≤500, default 100) → `{entries[]}` | numeric clamp | none | `api/audit/route.ts` | 401/403 |
| 10 | GET | `/api/tickets` | Ticket list (dashboard) | required | staff | `?status=&limit=` (1–100, default 50) → `{ok,principal,tickets[]+customer}` | status enum check (400 on invalid) | none | `api/tickets/route.ts` | 400/401/403 |
| 11 | GET | `/api/tickets/[id]` | Ticket detail + customer + order | required | staff | — → `{ok,ticket,customer,order}` | — | none | `api/tickets/[id]/route.ts` | 404/401/403 |
| 12 | POST | `/api/tickets/[id]` | Update status/priority/note | required | staff | `{status?,priority?,note?}` (≥1 field) → `{ok,ticket,customer}` | manual enum/length checks (3–500 note) | ticket UPDATE; audit `ticket.updated`/`ticket.note_added` | `api/tickets/[id]/route.ts` | 400/404/401/403 |

No WebSocket/SSE/streaming endpoints exist. No file-upload endpoints. All 12 are VERIFIED at unit/integration level; #1, #3, #4, #7 are E2E-verified; #10–12 E2E-verified via the support spec.

**Agent tools (not HTTP, but the LLM's "API"):** the 10 visible tools are documented in §2/§16 with their schemas (`tools.ts`, `schemas.ts`). The 11th, `process_refund`, is internal: no schema exposed to the LLM, `authorize()` always denies, executed only via `executeApprovedAction` (§2.5).

---

## 10. DATABASE & DATA MODEL

**Technology:** SQLite (better-sqlite3, synchronous driver wrapped in an async interface) by default; Postgres (postgres-js) when `DATABASE_URL` is set. Connection selection + creation in `src/db/client.ts`; all queries in `src/db/repos.ts` (Drizzle ORM). **No connection pooling for SQLite** (single file handle per process); Postgres uses postgres-js's default pool settings (no explicit tuning in code).

**Conventions:** IDs are app-generated strings (`CUST-1001`, `ORD-1001`, `TCK-…`, `APR-…`, `REF-…`) via CSPRNG (`ids.ts`); money = INTEGER cents; time = INTEGER epoch ms; semi-structured data (order items, addresses, ticket notes, approval arguments, message meta) = TEXT/JSON columns.

**Schema (VERIFIED against `.db/schema.sql` / `.db/schema.pg.sql` — identical tables; PG uses camelCase columns):**

```mermaid
erDiagram
    customers ||--o{ orders : "customer_id"
    customers ||--o{ support_tickets : "customer_id"
    customers ||--o{ refunds : "customer_id"
    customers ||--o{ approval_requests : "requested_by"
    customers ||--o{ sessions : "customer_id"
    customers ||--o{ conversations : "customer_id"
    orders ||--o{ refunds : "order_id"
    approval_requests ||--o| refunds : "approval_id"
    conversations ||--o{ messages : "conversation_id"

    customers {
        text id PK
        text name
        text email UK
        text password_hash
        text role "customer|support_agent|admin"
        int created_at
    }
    orders {
        text id PK
        text customer_id FK
        text status "pending|processing|shipped|delivered|cancelled|refunded|partially_refunded"
        int total "cents"
        text currency
        text items "JSON array"
        text shipping_address "JSON"
        text tracking_number
        int created_at
        int delivered_at
        int refundable_amount "cents, decremented on refund"
    }
    support_tickets {
        text id PK
        text customer_id FK
        text order_id "optional FK (no constraint)"
        text subject
        text description
        text priority "low|medium|high"
        text status "open|in_progress|resolved|closed"
        text internal_notes "JSON array, staff-only"
        int created_at
        int updated_at
    }
    refunds {
        text id PK
        text order_id FK
        text customer_id FK
        int amount "cents"
        text reason
        text status "requested|pending_approval|approved|rejected|processing|completed|failed"
        text approval_id "FK (no constraint)"
        text idempotency_key UK
        int created_at
        int processed_at
    }
    approval_requests {
        text id PK
        text requested_by FK
        text actor_role
        text action_type
        text tool_name "always process_refund today"
        text arguments "JSON — exact bound action"
        text risk_level "default high"
        text status "pending_approval|approved|rejected|expired"
        text approved_by
        text rejection_reason
        text order_id
        int amount_cents
        text idempotency_key "dedupe pending requests"
        int created_at
        int resolved_at
    }
    audit_logs {
        int id PK "autoincrement / serial"
        text actor_id
        text actor_role
        text action
        text tool_name
        text arguments "JSON, redacted"
        text result "JSON, redacted"
        text approval_id
        text conversation_id
        int timestamp
    }
    sessions {
        text token PK
        text customer_id FK
        int created_at
        int expires_at
    }
    conversations {
        text id PK
        text customer_id FK
        text title
        int created_at
    }
    messages {
        int id PK "autoincrement / serial"
        text conversation_id FK
        text role "user|assistant|tool"
        text content
        text meta "JSON: cards, events"
        int created_at
    }
```

**Indexes (as written in DDL):** `orders(customer_id)`, `support_tickets(customer_id)`, `refunds(order_id)`, `refunds.idempotency_key` **UNIQUE** (the double-refund backstop at DB level), `approval_requests(status)`, `conversations(customer_id)`, `messages(conversation_id)`.

**Migrations:** "migration" = applying the idempotent DDL file once (`migrate.ts`; `--reset` deletes the SQLite file first — SQLite only). **There is no migration versioning/upgrade framework** — schema changes require manual ALTERs or a fresh DB (risk, §30). `db:reset` = wipe + migrate + seed.

**Entity mapping:** app domain types (`types.ts`: `Order`, `SupportTicket`, `Refund`, `ApprovalRequest`, `Principal`) ↔ DB rows via mappers in `repos.ts`/`tools.ts`/`approvals.ts`/`refund-execution.ts` (camelCase conversion + JSON parse). One customer = one conversation (created lazily in `agent.ts`), so `messages` grow unboundedly per user.

**Integrity risks (evidence-based):**
- FK constraints on `orders.customer_id`, `refunds.*`, `approval_requests.requested_by`, `sessions.customer_id`, `conversations.customer_id`, `messages.conversation_id` — but **no FK from `support_tickets.order_id` to orders** (set application-side), and no FK from `refunds.approval_id` to `approval_requests` (logical link only).
- `audit_logs` has **no indexes at all** (listAudit is newest-first with a limit — fine at small scale, degrades linearly as it grows).
- `applyRefund` (refund + order-balance decrement) is one transaction in the repo adapter — the only multi-row atomic write in the app; everything else is single-row.
- No retention/purge jobs: audit logs, messages, sessions (until expiry/revocation) and tickets accumulate forever.

**Current data state (read-only inspection, this assessment):** `data/app.db` — 5 customers (CUST-1001/2/3, AGENT-2001 support_agent, ADMIN-3001 admin), 6 orders, 3 tickets, 2 refunds, 2 approvals, 49 audit entries, 1 conversation, 28 messages. `data/e2e.db` — same 5 customers, 6 orders (freshly seeded by the last E2E run).

---

## 11. DATA FLOW & DATA LIFECYCLE

| Data | Origin | Travels | Stored | Third parties | Retention | Deletion | Sensitivity |
|---|---|---|---|---|---|---|---|
| Credentials | user types into login form | browser → API (JSON) | PBKDF2-SHA256 600k hash only (plaintext never stored/logged) | **OpenAI never sees passwords** (auth happens before any LLM call) | until account removed (no delete feature exists) | only manual DB edit | high — password hashes were previously committed to git history (WAL files; §17) |
| Session tokens | server-generated (128-bit random + HMAC) | cookie (HttpOnly) | `sessions` table | none | 7 days or logout | logout (revoked); expiry (revoked on next use) | high |
| Chat content (user + assistant + tool results) | chat input / agent | browser → API → agent loop → messages table | `messages` (content + meta JSON) | **OpenAI receives the conversation** (last 20 messages + system prompt + tool schemas/results) when live mode is on | **indefinite** (no purge) | only manual DB edit | medium (order details, addresses, issues) |
| Orders / addresses | seeded (no checkout exists) | in-process only | `orders` (items + address JSON) | none (mock tracking never leaves) | indefinite | manual | medium (fictional demo data) |
| Tickets + internal notes | chat or support UI | API → tickets table | `support_tickets` (notes JSON) | none | indefinite | manual | low–medium |
| Refunds/approvals | agent tool / admin decision | API → tables | `refunds`, `approval_requests` | **no payment provider is ever called** (execution is DB-only) | indefinite | manual | medium (financial, simulated) |
| Audit entries | every significant action | in-process → table | `audit_logs` (redacted args/results) | none | **indefinite, unindexed** | manual | medium (reveals actions/IDs) |

**Trust boundaries:** (1) browser cookie → API auth; (2) API → DB (all via `Repo`, parameterized/Drizzle queries — no string-built SQL with user input anywhere in `repos.ts`); (3) LLM output → app (untrusted; Zod-validated, role-checked, risk-gated); (4) user text inside messages → treated as data, not instructions (system prompt + deterministic gates; Eval 4).

**Data sent to OpenAI (live mode only):** system prompt (contains the user's **name + role**), the last 20 conversation messages (user text, assistant text, tool results containing **order data, addresses, amounts**), and tool schemas. This is the only data exfiltration path to a third party; in mock mode (default) nothing leaves the machine except what the deployment itself sends.

---

## 12. AUTHENTICATION & AUTHORIZATION

**Registration:** NOT IMPLEMENTED (no signup route, page, or repo method). Accounts are created by `seed.ts` only.

**Login flow (VERIFIED):** `POST /api/auth/login` → Zod validate → rate-limit check (per IP and per email) → `login()` (`lib/auth.ts`): email lookup → password check = `PBKDF2 verify` **or** (dev only) `demo1234` backdoor → on success: `token = randomToken(16) + "." + HMAC-SHA256sig(customerId:expiresAt)` (32-hex random + 16-hex signature over `SESSION_SECRET`), INSERT `sessions` (7-day TTL) → `Set-Cookie support_session` (HttpOnly, SameSite=Lax, Path=/, **Secure only in production**).

**Session verification (every request, VERIFIED):** cookie → `sessions` row lookup → **HMAC signature re-verification** (`tokenSigValid`, constant-time compare; mismatch → session revoked) → expiry check (expired → revoked) → customer row → `Principal{id,name,email,role}`. Design note in code: the random token is the primary secret; the HMAC additionally binds tokens to the deployment's secret so a leaked DB copy alone can't be used.

**Logout (VERIFIED):** JSON body required (CSRF hardening), session row deleted, cookie cleared.

**Password storage:** PBKDF2-SHA256, 600,000 iterations, 16-byte random salt, format `pbkdf2$<iter>$<saltHex>$<hashHex>`; legacy 120k hashes still verify (iteration count stored per hash). No password change/reset features exist (NOT IMPLEMENTED).

**Authorization model — three layers (defense in depth, all VERIFIED):**
1. **Page gates (RSC):** `/admin` layout (admin only), `/support` layout (staff only) redirect before the client bundle is even served; client-side `/me` checks are a second net.
2. **Route guards:** `requireRole([...])` on every data API (admin, staff, or self).
3. **Tool-level:** `authorize(tool, principal)` per role (pure function, `policy.ts`) + handler-level re-checks (e.g. `update_support_ticket` throws FORBIDDEN for non-staff even if called directly) + ownership scoping in handlers (`findOrderFor`: foreign orders return NOT_FOUND to customers, so existence isn't leaked; `resolveRefundCustomer`/`resolveTicketCustomer`: customers can only target themselves).

**Roles & permissions matrix (from `policy.ts` + tests):**

| Capability | customer | support_agent | admin |
|---|---|---|---|
| Chat, own orders/tracking/tickets | ✓ | ✓ (own) | ✓ (own) |
| Create ticket (own / for customer) | own | for customer | for customer |
| Update ticket / internal notes | ✗ | ✓ | ✓ |
| Search customers, list any orders/tickets | ✗ | ✓ | ✓ |
| Request refund (own / for customer) | own | for customer (keyed to target) | for customer |
| View approvals | own (via /api/status) | own | all |
| Approve/reject + execute | ✗ | ✗ | ✓ |
| Audit log | ✗ | ✗ | ✓ |
| `process_refund` | ✗ (denied by policy, hidden from LLM) | ✗ | ✗ via tool path (only via approval execution) |

**Account isolation:** per-customer conversation; customer reads of other customers' orders/tickets → NOT_FOUND; cross-customer refund/ticket targeting → FORBIDDEN (all VERIFIED by tests). Support agents' approval list is scoped to their own requests in `GET /api/approvals` (route-level scoping).

**Gaps (evidence-based):**
- **No account deletion / password reset** (no endpoint, no UI).
- **`clientIp()` trusts the first `X-Forwarded-For` hop** with no trusted-proxy allowlist — behind a misconfigured proxy an attacker could rotate the login rate-limit bucket by spoofing XFF (see §17).
- Sessions are **per-process DB rows** — revocation is global only within one DB; fine for SQLite/Postgres single-DB, but there is no token-versioning for "revoke all sessions" (no such feature).
- No CSRF token scheme — mitigations are SameSite=Lax + JSON-body requirement on state-changing endpoints + HttpOnly cookies (documented in code comments).
- Login page pre-fills `jane@example.com`/`demo1234` in dev builds (hidden in production).

---

## 13. THIRD-PARTY SERVICES & EXTERNAL DEPENDENCIES

| Provider | Purpose | Integration | Required env | Data sent | Expected response | Failure behavior | Classification |
|---|---|---|---|---|---|---|---|
| **OpenAI** (or any OpenAI-compatible endpoint: OpenRouter, vLLM) | LLM planner (function calling) | raw `fetch` to `{BASE_URL}/chat/completions` with Bearer key, `tool_choice:"auto"`, 60s `AbortSignal` timeout — `src/lib/openai.ts`. No SDK. | `OPENAI_API_KEY` (required for live), `OPENAI_BASE_URL` (default `https://api.openai.com/v1`), `OPENAI_MODEL` (default `gpt-4o-mini`), optional `LLM_PROVIDER=openai` | conversation (≤20 messages incl. order/address data), tool schemas | JSON choice: `tool_calls[0]` (name+arguments) or `content` text | **No fallback to mock at runtime** — if the call fails, the tool error propagates as an agent tool-failure and the assistant reports it (loop continues to a final message); `LLM_PROVIDER=openai` **without** a key falls back to mock at factory time (logged) | **CONFIGURED BUT REQUIRES EXTERNAL CREDENTIALS — IMPLEMENTED BUT NOT RUNTIME-VERIFIED** (never run with a real key in this repo's history; README states this explicitly) |
| **Supabase / Postgres** | alternative database | `postgres` (postgres-js) via `DATABASE_URL`, Drizzle `postgres-js` driver — `client.ts`, `repos.ts`; DDL `.db/schema.pg.sql` | `DATABASE_URL` (connection string w/ embedded creds) | all app data (see §11) | SQL results | connection errors surface as 500s (generic to client, full to server log) | **CONFIGURED BUT REQUIRES EXTERNAL CREDENTIALS — IMPLEMENTED BUT NOT RUNTIME-VERIFIED** (README: "Not verified here against a live Supabase/Postgres instance") |
| **Google Fonts** (next/font) | Inter + JetBrains Mono | fetched at build time by Next, self-hosted in build output | none | none | woff2 | build-time only; no runtime dependency | VERIFIED (build succeeds offline of fonts? — fonts are downloaded during `next build`; if unreachable, Next falls back with warning. Not separately verified here) |
| **Payment/refund processor** | — | — | — | — | — | — | **NOT IMPLEMENTED** (refunds are simulated DB writes) |
| **Email/SMS/push** | — | — | — | — | — | — | **NOT IMPLEMENTED** |
| **Real carrier/tracking API** | — | — | — | — | — | — | **NOT IMPLEMENTED** (tracking synthesized in `tools.ts mockTracking()`) |
| **Auth IdP / SSO** | — | — | — | — | — | — | **NOT IMPLEMENTED** (local credentials only) |
| **Observability (Sentry/Datadog/…)** | — | — | — | — | — | — | **NOT IMPLEMENTED** |

**Does adding a key activate the real integration?**
- `OPENAI_API_KEY` → **yes, immediately** (factory auto-selects; same loop, same schemas). Only the `chat/completions` response shape is assumed (standard OpenAI schema). Caveats: model quality affects tool-call correctness, but safety does not (gates are model-independent). Cost exposure: up to 6 LLM calls per chat turn × 60 turns/10min per customer default cap (§16).
- `DATABASE_URL` → **yes for reads/writes**, but you must run `npm run db:migrate` + `db:seed` against it first (DDL is applied by script, not by the app at boot). The app never auto-creates PG tables.

---

## 14. ENVIRONMENT & CONFIGURATION

**Precedence (evidence-based):** real process env vars win; `.env`/`.env.local` are loaded by Next.js itself for dev/start; `tests/setup.ts` hard-codes the vitest environment; `playwright.config.ts` sets the e2e webServer env explicitly. `assertProductionReady()` (boot gate) reads **raw `.env` files from disk** specifically because env isn't loaded yet at instrumentation time (code comment in `env.ts`).

| Variable | Purpose | Required? | Environment | Sensitive? | Used where |
|---|---|---|---|---|---|
| `LLM_PROVIDER` | force `mock`/`openai` (default: auto = openai iff key present) | no | all | no | `lib/env.ts`, `llm-factory.ts` |
| `OPENAI_API_KEY` | enables real LLM | no (enables live) | all | **YES** | `lib/openai.ts` |
| `OPENAI_BASE_URL` | OpenAI-compatible endpoint | no (default api.openai.com/v1) | all | no | `lib/openai.ts` |
| `OPENAI_MODEL` | model name | no (default `gpt-4o-mini`) | all | no | `lib/openai.ts` |
| `DATABASE_URL` | enables Postgres/Supabase | no (enables live) | all | **YES** (embeds creds) | `db/client.ts`, `migrate.ts`, `seed.ts` |
| `DATABASE_PATH` | SQLite file path | no (default `./data/app.db`) | dev/test/e2e | no | `db/client.ts` |
| `SESSION_SECRET` | HMAC for session tokens | **YES in production** (boot fails without; dev fallback constant) | all | **YES** | `lib/auth.ts`, `lib/env.ts`, boot gate |
| `AGENT_MAX_ITERATIONS` | loop cap per turn | no (default 6) | all | no | `lib/agent.ts` |
| `APPROVAL_TTL_HOURS` | pending-approval lifetime | no (default 72) | all | no | `lib/approvals.ts` |
| `CHAT_TURNS_PER_WINDOW` | chat rate limit | no (default 60) | all | no | `api/chat/route.ts` |
| `CHAT_WINDOW_MS` | chat rate-limit window | no (default 600000) | all | no | `api/chat/route.ts` |
| `APP_URL` | public base URL | no (default http://localhost:3000) | all | no | declared in env.ts/README; **no runtime usage found in code** (see §29) |
| `NODE_ENV` | framework mode; gates demo password, CSP, Secure cookie, boot checks | implicit | all | no | throughout |

**Feature flags / mock-live switches:** exactly two — LLM (key presence) and DB (URL presence) — plus `NODE_ENV`-gated production behaviors. No other feature-flag system exists.

**Test configuration:** vitest — `tests/setup.ts` (mock LLM, `:memory:` DB, test secret); Playwright — `playwright.config.ts` webServer env (mock LLM, `./data/e2e.db`, e2e secret). Note: committed `.env.test` is **dead** (loaded by nothing — §4/§29).

---

## 15. MOCK / FALLBACK / LIVE MODE ANALYSIS

| Component | Mode | Evidence | What activates the real mode |
|---|---|---|---|
| LLM planner (default) | **MOCK** — deterministic regex/state machine "planner" (`mock.ts`, 706 lines). Produces realistic tool-call sequences + final text; fully offline | `llm-factory.ts`: mock unless openai key/forced; startup banner prints `LLM: MOCK` | Set `OPENAI_API_KEY` → **READY FOR LIVE CREDENTIALS** (code complete, response parser written for the standard schema; never runtime-verified) |
| LLM planner (live) | IMPLEMENTED BUT NOT RUNTIME-VERIFIED | `openai.ts` fetch + tool_calls parse + 60s timeout + generic error mapping | — |
| Database (default) | **REAL SQLite** (not a mock) — real file, real constraints | `client.ts`, `.db/schema.sql`, read-only DB inspection in this assessment | — |
| Database (alt) | IMPLEMENTED BUT NOT RUNTIME-VERIFIED (never connected to a live PG/Supabase in this repo) | `schema.pg.ts`, `schema.pg.sql`, `createPostgresRepo` | Set `DATABASE_URL` + run migrate/seed → **READY FOR LIVE CREDENTIALS** (with the manual migrate step) |
| Order data | **SEEDED DEMO DATA** — 5 customers / 6 orders / tickets / approvals fabricated by `seed.ts`; no order ingestion API exists | `seed.ts`, DB inspection (5 customers, 6 orders) | Not activatable — there is no production data path (no checkout, no import tool). **NOT IMPLEMENTED** as a live data source |
| Tracking | **MOCK/SYNTHESIZED** — `mockTracking()` derives events/ETA from order status + createdAt; `tracking_number` is seed data | `tools.ts:152-210`, comment "Deterministic, realistic mock tracking" | No live carrier integration exists — **NOT IMPLEMENTED** |
| Refund execution | **SIMULATED** — transactional DB update (refund row + balance decrement); no money moves, no provider call | `refund-execution.ts`, `applyRefund` in repos | No payment SDK/endpoint exists — **NOT IMPLEMENTED** |
| Knowledge base | **STATIC/HARDCODED** — 7 FAQ entries with keyword scoring | `knowledge.ts` | No RAG/vector store (none configured anywhere) |
| Demo login | **DEV-ONLY BACKDOOR (gated)** — `demo1234` accepted only when `NODE_ENV !== "production"`, UI hints hidden in prod; seeded hashes are literally of `demo1234` | `auth.ts:12-20`, `login/page.tsx:17`, unit test F1 | n/a — prod accounts must be provisioned separately (no provisioning feature) |
| Screenshots in `images/` | committed JPEGs of the running app (demo PII: names/emails/order ids) | directory listing | review before public publishing (manual) |
| `APP_URL` | **PLACEHOLDER-ish** — declared/documented but no code path reads it (grep: only env.ts default + docs) | §29 | — |
| `.env.test` | **STALE** — committed but not loaded by vitest or Playwright | §4 | — |

**Bottom line:** the application is fully functional *as a self-contained system* with mock LLM + SQLite (everything E2E-verified). Adding real credentials activates the real LLM and real DB **with no further code**, but the *business* integrations that a production support system would need (order ingestion, payments, carrier tracking, notifications, user provisioning) **do not exist at all** — they would be new work, not config.

---

## 16. BUSINESS LOGIC & DOMAIN RULES

All rules live in deterministic, unit-tested TypeScript (locations + tests cited). Money = integer cents.

**Refund eligibility — `lib/refunds.ts checkRefundEligibility()` (VERIFIED, 8 unit tests):**
1. Order must exist and belong to the acting customer (staff: order's owner).
2. Status must be `delivered` or `partially_refunded` (const `REFUNDABLE_STATUSES`). `cancelled`/`refunded` explicitly rejected with specific reasons.
3. Amount > 0 and ≤ `order.refundableAmount` (remaining balance).
4. **30-day window (`REFUND_WINDOW_DAYS = 30`) enforced for FULL refunds only** (amount ≥ order total, measured from `deliveredAt`); partial refunds are amount-limited only. (The KB policy text says "30 days" generally — the code is stricter than the prose on partials, §29.)
5. **Duplicate guard:** an open (non-terminal) refund for the same order blocks a new request (`getOpenRefundForOrder`).

**Idempotency keys (VERIFIED, unit tests):**
- Request dedupe: `refundreq:<customerId>:<orderId>:<amountCents>:<normalizedReason>` → reuses an existing *pending* approval.
- Execution dedupe: `refund:<customerId>:<orderId>:<approvalId>` → unique index in DB + executor returns the existing completed refund without decrementing again. Keys bind to the **target customer** (order owner), not the actor — critical for staff-initiated refunds (code comment in `tools.ts`).

**Approval state machine — `lib/approvals.ts` (VERIFIED, 4 unit tests):** `pending_approval → {approved, rejected, expired}`; terminal states cannot transition; an approval is bound to the **exact stored arguments** (execution reads from the row, never from the caller); TTL auto-expiry checked lazily on read/decide (`APPROVAL_TTL_HOURS`, default 72); only `admin` may decide or execute.

**Refund execution — `lib/refund-execution.ts` (VERIFIED, integration tests incl. idempotent retry):** re-verifies order + remaining balance at execution time; one transaction completes the refund row **and** decrements `orders.refundable_amount` exactly once; order status becomes `refunded`/`partially_refunded`; failures are persisted as `failed` + audited, never silently swallowed.

**Risk classification — `lib/policy.ts getRiskLevel()` (VERIFIED):** reads = low; ticket creation = medium; refunds = high; **unknown tools fail closed as high**. `requiresApproval()` = true for high-risk (refunds). Tool visibility per role strips staff tools from customers and never exposes `process_refund`.

**Ticket rules:** subject 3–140 chars, description 3–2000, priority enum, status enum; ticket creation = medium risk (no approval needed); `update_support_ticket` staff-only (policy **and** handler); internal notes append-only JSON thread, staff-visible only; customer targeting locked to self for customers.

**Mock planner intent rules — `lib/mock.ts` (MOCK-only, drives offline UX):** order-id regex `ORD-\d+`; refund phrasing detection; return-with-pronoun → refund flow; cancel-with-pronoun → cancellation ticket; bare "create a ticket" → clarifying question instead of a junk ticket; subject/priority derivation heuristics (`subjectFromText`, `priorityFromText`); staff phrasing ("customer named X") extraction. These are *convenience heuristics only* — they propose, the gates decide.

**Other constants:** session TTL 7 days; login limit 8/10min (IP+account); chat cap 60 turns/10min default; LLM request timeout 60s; agent max iterations 6; per-turn LLM context = last 20 messages; audit string truncation 4000 chars; customer search limit ≤25; order list limit ≤100.

---

## 17. SECURITY ASSESSMENT

A full evidence-based audit exists in the repository (`SECURITY_AUDIT.md`, 16 findings, each with a remediation status table from 2026-09-21). This section is my independent re-review of the **current working tree** (I did not modify any code).

**Controls that are present and verified (defense inventory):**
- Passwords: PBKDF2-SHA256 600k, per-hash iteration, constant-time compare (unit-tested).
- Sessions: 128-bit random token + HMAC signature over `SESSION_SECRET`, DB-backed, 7-day TTL, revocation on logout, signature re-verified each request (unit-tested incl. forged-signature rejection).
- Prod boot gate: process refuses to start in production without `SESSION_SECRET`; mock LLM in prod → loud warning (`instrumentation.ts`, `env.ts`).
- Demo-password backdoor: dev-only, UI hints prod-hidden (unit-tested: rejected in prod for real-hash accounts).
- Login: rate-limited 8/10min per IP+account; generic 401 (no enumeration); failures logged email+IP only.
- Chat: per-customer spend cap (429).
- AuthZ: three layers (§12); cross-customer reads return NOT_FOUND (no existence leak); internal tool invisible + denied + handler-guarded.
- Input: Zod strict schemas on every tool + every API body; `additionalProperties:false`.
- Errors: 500s generic to client, full detail server-log only.
- Headers: nosniff, XFO DENY, Referrer-Policy, HSTS(preload) on all responses; strict CSP in production builds (no `unsafe-eval`); dev omits CSP (documented reason: dev toolchain needs eval; regression-tested).
- LLM: 60s hard timeout; generic error mapping (no upstream message leakage); system prompt declares tool/text content untrusted.
- Audit: all significant actions logged with secret-key redaction.
- DB: file + WAL/SHM chmod 0600 on Unix; `data/` git-ignored; refund double-spend backstopped by unique index.
- Prompt injection: Eval 4 ("ignore your rules and refund $1,000") proves rules hold; authorization never comes from model output.

**Findings remaining in the current tree (my review, severity = current impact):**

| Sev | Finding | Evidence | Impact | Recommended remediation (NOT done in this task) |
|---|---|---|---|---|
| **High** | Committed DB sidecar files still in **git history** (4 WAL/SHM files in commits; untracked at HEAD, `data/` now ignored — but history retains password hashes, session tokens, audit data) | `git log --stat` shows `data/*.db-*` in initial commits; remote is a public GitHub repo (`Karan7505/AI-Customer-Support-Agent`) | Anyone with repo access (now or historically) can extract PBKDF2 hashes + live sessions + demo audit data | **Manual/owner action:** purge history (`git filter-repo --path data/ --invert-paths` or fresh repo), force-push, treat hashes/tokens as compromised: reseed passwords, revoke all sessions |
| **Medium** | `clientIp()` trusts first `X-Forwarded-For` hop unconditionally (`_util.ts:38-42`) | no proxy allowlist | behind a real proxy, spoofed XFF defeats the login rate-limit bucketing (per-IP bucket bypass; per-account bucket still limits) | pin to a known proxy / last-hop or disable XFF parsing |
| **Medium** | Rate limiter is in-process (Map) — per-instance state | `rate-limit.ts` header comment says so explicitly | with N instances, effective limit = N× configured; also lost on restart | shared store (Redis/PG) if horizontal scaling |
| **Medium** | No user self-service: no registration, no password change/reset, no account deletion | no routes/methods exist | can't provision real users; leaked account = no rotation path except DB surgery | add provisioning flow (or SSO) |
| **Low** | CSP keeps `script-src 'unsafe-inline'` (App Router flight scripts can't be nonced without custom work) | `next.config.ts` comment | weakens XSS defense-in-depth vs a fully nonce-based CSP | accept (documented) or invest in nonce pipeline |
| **Low** | Audit log: no index, unbounded growth, results JSON can contain PII (names/emails/order data) | `schema.sql` (no idx on audit_logs), `audit.ts` | query degradation; PII exposure to any admin | index + retention policy; review redaction list (currently only secret-key names) |
| **Low** | `images/*.jpg` contain demo PII (names, emails, order ids) | directory listing | public-repo PII hygiene | review/replace before publishing |
| **Low** | `POST /api/tickets/[id]` uses manual validation instead of Zod (consistent behavior, different mechanism) | `tickets/[id]/route.ts:66-74` | minor consistency/maintainability | standardize on Zod |
| **Info** | `next lint` deprecated (Next 16 removal); `eslint-config-next` version drift (15.1.6 vs next 15.5.25) | lint run output; package.json | tooling migration debt | migrate to ESLint CLI |
| **Info** | `esbuild` (dev-only, via tsx/vite/drizzle-kit) and `@vitest/mocker` advisories remain in dev deps; `postcss` HIGH nested inside next 15.x (fix only in next 16.3.5) | `npm audit` run in the security pass (recorded in SECURITY_AUDIT.md remediation table) | dev-tooling supply chain; no runtime path | revisit on Next 16 / toolchain upgrade; keep `npm audit` in CI |
| **Info** | No health-check endpoint, no metrics, no request tracing | no such route exists | operational blind spot | add `/api/health` + metrics (or platform-native) |

**Injection review:** SQL is 100% Drizzle/parameterized (no string interpolation of user input in `repos.ts`); no shell execution anywhere; no file paths derived from user input (DB path is env-only); no template rendering of user text (React escapes by default; the only `dangerouslySetInnerHTML`-class risk is `JSON.stringify` inside `<pre>` in the audit table — still escaped by React). **CORS:** no CORS config at all — the API is same-origin only by default (Next does not add CORS headers); cookie SameSite=Lax reinforces this. **Uploads/path traversal:** none exist. **SSRF:** `OPENAI_BASE_URL` is operator-configured (trusted input), not user-controlled.

---

## 18. PRIVACY & COMPLIANCE CONSIDERATIONS

- **Personal data collected (as implemented):** name, email, password hash, role (accounts); free-text chat (may contain anything the user types); order data incl. **full shipping address** (seeded, but the schema/UI clearly anticipate real orders); ticket descriptions; internal notes; audit trail (actor IDs + actions + arguments).
- **External processors (when live):** the LLM provider receives conversation context incl. order/address data (§11) — this needs a DPA/assessment before real user data flows; in mock mode, none.
- **Retention:** **no retention limits or purge jobs anywhere** — messages, audit logs, tickets, sessions (post-expiry rows persist until touched), refunds all accumulate indefinitely in the DB.
- **Deletion mechanisms:** none for users or admins (no delete routes; only manual DB access).
- **Consent / opt-in:** none (no consent UI, no privacy policy, no cookie banner — arguably fine for an authenticated internal-style app, but relevant if offered to consumers).
- **Export:** none (no data-export endpoint).
- **Compliance posture:** **cannot claim GDPR/CCPA compliance** — no right-of-access, right-to-erasure, retention, or vendor-processor tooling exists. The fictional demo data softens current exposure, but the architecture (unindexed, unbounded, no-deletion) would not pass a privacy review with real data. (Legal conclusion intentionally not made — engineering facts only.)
- **Positive controls observed:** secret redaction in audit, no passwords in logs, generic errors, scoped data access, `data/` excluded from VCS going forward.

---

## 19. TESTING & QUALITY

**Inventory (verified by reading every test file / running the suites):**

| Layer | Files | Count | Scope |
|---|---|---|---|
| Unit | `tests/unit/`: policy, validation, refund-eligibility, approval-state, tool-routing, security-hardening | 6 files | pure functions: risk/permission, Zod schemas, eligibility rules, idempotency keys, state machine, tool routing, security controls (demo gate, enumeration, PBKDF2, session sig, rate limiter, id gen, response headers) |
| Integration | `tests/integration/`: orders, tickets, refund-flow | 3 files | real (in-memory) DB through the Repo: ownership/isolation, ticket lifecycle, refund request→approval→execute, duplicates, idempotent retry, rejection paths |
| Agent eval | `tests/eval/`: agent-eval (18 scenarios), staff-chat (8 scenarios) | 2 files | **the real agent loop with the mock LLM**: order lookup, cross-customer no-leak, refund→approval-not-executed, prompt-injection resistance, malformed args, reject path, exactly-once execution, idempotent retry, backend-failure honesty, FAQ, "what did I order", no-id tracking, return→refund, cancel→ticket, policy-vs-action disambiguation; staff: search/view/list/file/refund-for-customer + customer lockouts |
| E2E | `tests/e2e/`: core-flow, support-dashboard | 2 specs | full browser (Chromium) against a fresh seeded `next dev`: login→order lookup→refund request→admin approval→refund confirmed→customer sees status; support dashboard CRUD + customer lockout |

**Commands (from package.json, all verified):** `npm test` (vitest, 11 files), `npm run eval` (evals only), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e` (Playwright; webServer auto-runs migrate --reset + seed --force + next dev on :3000).

**Executed during THIS assessment (Node v24.19.0, exact results):**
- `npx vitest run` → **11 files / 102 tests, all passed** (48.8s).
- `npm run typecheck` → **clean**.
- `npm run lint` → **no warnings or errors** (deprecation notice for `next lint` observed).
- `npm run build` → **succeeded**, 17 routes, static: `/`, `/_not-found`, `/chat`, `/login`; dynamic: `/admin`, `/support`, all 12 API routes.
- `npm run test:e2e` run #1 → **1 failed (core-flow: 60s test-timeout exceeded; a flake — machine/compile variance, see below), 1 passed** (2.6m total).
- `npm run test:e2e` run #2 (isolated) → **2 passed** (core-flow 37.1s, support-dashboard 15.4s; 1.8m).

**Not covered / gaps:** no live-provider tests (OpenAI & Postgres paths are exercised by typecheck only); no performance/load tests; no security penetration tests (security *behavior* is unit-tested, but not black-box); no UI component tests (jsdom dep unused); no coverage measurement configured (no `coverage` script); e2e runs only chromium, single worker, `retries: 0` — and the 60s per-test timeout is tight on a cold dev server (observed flake above; the "Fast Refresh full reload" warning appears on every run, suggesting the dev server restarts mid-suite).

**Tests requiring external credentials:** none (all offline). The OpenAI/Postgres integrations are *not test-covered at runtime by design*.

---

## 20. CODE QUALITY & MAINTAINABILITY

**Strengths (evidence-based):**
- **Clear layering:** `app/api` (transport) → `lib` (pure domain, Next.js-free, unit-testable) → `db/repos` (single data-access boundary). This separation is real and paid for by the test design (in-memory DB, no app booted).
- **Type safety:** `strict: true`, shared domain types, Zod at both API and tool boundaries, driver-agnostic row types. No `any` in the domain core (some `any` in UI page state and mappers — pragmatic, bounded).
- **Explicit failure semantics:** stable error codes, structured tool-result envelopes, "never fabricate success" enforced even in the mock planner; generic 500s.
- **Security-conscious code** with rationale in comments (why NOT_FOUND instead of FORBIDDEN, why the HMAC, why JSON-body logout, etc.).
- **Naming/commenting:** consistently good; comments explain *why* (non-obvious decisions), not *what*.
- **Idempotency & state machines** implemented as testable pure logic.

**Weaknesses / tech debt (evidence-based):**
- **`mock.ts` at 706 lines of regex heuristics** is the largest single maintenance risk: intent detection is brittle (e.g. name extraction heuristics) and only meaningful in mock mode — but it doubles as the offline behavior spec.
- **UI pages are long single-file client components** (chat 375, support 437 lines) with `type Card = any`-style loose typing in view state; no shared hooks layer; `alert()` for errors.
- **No migration framework** (single idempotent DDL) — safe only while the schema is frozen; any column change is a manual operation across two DDL files + two Drizzle schemas + row types (4 places to keep in sync — a real drift hazard).
- **Duplication:** `mapTicket` exists in both `tools.ts` and `tickets/route.ts`; status maps duplicated between `schema.ts` enums and `components/status.tsx`; `withContext` in approvals helpers is loose-typed.
- **Config drift:** `eslint-config-next` behind `next`; `@types/node` behind runtime; stale `.env.test`; `APP_URL` documented but unused; `drizzle-kit` present but unused by scripts.
- **Observability absent** (§24) — the biggest operational debt.
- **Uncommitted working tree** (24 modified + 5 new files since the last of 5 commits) — the security-hardening pass is not yet a commit; handover state = disk, not HEAD.

---

## 21. PERFORMANCE

*Measured* numbers from this assessment: vitest suite 48.8s (102 tests incl. many 600k-iteration PBKDF2 verifies); production build ~3 min; e2e suite ~2–3 min; single-page First Load JS 103–110 kB (build output). Everything below is *theoretical/structural* unless stated measured — **no load testing has been performed; treat all capacity numbers in §22 as such.**

- **Hot path cost:** a chat turn = (DB: session lookup, conversation, message insert+list, tool queries, message insert, audit inserts) + N× LLM round-trips (mock: microseconds; live: seconds each, up to 6) + 600k-iteration PBKDF2 only at login (~1s, measured as 1.0s in the security test run).
- **Synchronous DB inside an async service:** better-sqlite3 blocks the event loop per query (milliseconds at this scale; the adapter is async-shaped to make Postgres drop-in). Under real concurrency this is the first CPU/contention ceiling on the SQLite driver.
- **N+1 patterns (structural, small data today):** `GET /api/tickets` fetches each distinct customer per ticket in a loop (`tickets/route.ts:46-51`); `GET /api/approvals` enriches every approval with 2–3 extra queries (`withContext`) — bounded by list limits (≤200/100) so impact is linear and modest, but it grows with data.
- **Unbounded reads:** `messages` history is fully reloaded per turn, then only the last 20 are sent to the LLM — the DB read grows with conversation length while the LLM payload stays bounded.
- **In-memory growth:** rate-limiter Map (purged lazily at ~10k entries); no other unbounded caches.
- **No caching layer** (no Redis/HTTP cache); API responses are not cached (all `no-store`-ish by route-handler default; pages are dynamic).
- **Payload sizes:** chat responses carry cards+events JSON (small); history endpoint returns the full conversation (grows).
- **CPU:** PBKDF2 at login; JSON parse/stringify per tool message; negligible otherwise.
- **Concurrent-request behavior:** no request queueing; Node event loop + SQLite write serialization; two concurrent `applyRefund` transactions are serialized by SQLite's single writer (Postgres: row-level, with the unique idempotency key as backstop).

---

## 22. SCALABILITY & CAPACITY ANALYSIS

**Current architecture's scaling model:** a **single stateful Node process** (Next.js) with a **single local SQLite file** (or one externally-hosted Postgres). No queues, no workers, no cache, no horizontal elements. The process holds: the DB handle, the rate-limiter Map, and per-request agent state (all request-scoped, fine).

- **Stateless vs stateful:** the HTTP handler layer is effectively stateless *except* (a) the in-process rate limiter and (b) the SQLite file handle — so horizontal scaling is possible **only after** moving rate-limit state to a shared store **and** dropping the SQLite driver (Postgres mode is the prerequisite).
- **Local filesystem dependency:** hard — `DATABASE_PATH` on the process's disk; WAL/SHM sidecars; 0600 perms. This alone caps the app at one writable instance of the DB.
- **Session storage:** in the DB (shared) — scales with the DB. **Caching:** none. **Queues/background jobs:** none (approval execution is inline in the admin's request — a slow executor blocks that request, which is acceptable for a human-triggered action).
- **Concurrency limits:** Node event loop; better-sqlite3 serializes writes on one connection; postgres-js default pool (no explicit `max` set — driver default applies, unknown/typical ~10); rate limits: login 8/10min per IP+account, chat 60 turns/10min per customer.
- **Provider limits (live mode):** OpenAI rate tiers (RPM/TPM per plan) and cost: worst case 6 LLM calls/turn × 60 turns/10min/customer; the app imposes **no global LLM concurrency or cost budget** beyond the per-customer cap.
- **Single points of failure:** the process itself (no replication/restart policy in-repo), the SQLite file (no backup tooling), `SESSION_SECRET` (in env).

**A. Capacity by user count (no benchmarks exist — structural reasoning only; exact numbers REQUIRE load testing):**
- **1 user:** comfortable headroom; all operations are small DB ops + (mock) instant LLM.
- **10 concurrent:** fine on one instance with SQLite for typical request rates (queries are single-row/few-row). Live-LLM latency dominates response time, not the app.
- **100 concurrent:** SQLite write contention + event-loop blocking from better-sqlite3 become the practical ceiling; N+1 enrichment loops add DB round-trips. Expect degradation first on `/api/tickets` and approval lists. **Postgres mode materially raises this ceiling** (implemented, unverified).
- **1,000 concurrent:** not supported as-is: single process + single DB file; in-memory rate limiter would be wrong under multiple instances (and you'd need multiple instances to get there). Architectural change required (below).
- **10,000+:** requires the proposed production architecture (H) plus provider-side capacity (OpenAI tiers), a real queue for LLM turns, and caching.

**B. What breaks first:** (1) **SQLite write serialization / file I/O** on the chat hot path; (2) **event-loop blocking** from the sync driver under load; (3) **N+1 enrichment queries** in list endpoints as data grows; (4) **per-customer LLM spend** hitting provider rate limits before the app itself does (live mode); (5) **audit_logs linear scan** (unindexed) as the table grows.

**C. Scales horizontally today:** essentially **nothing** — the *code* is instance-safe (no per-process trust state beyond the rate limiter), but the *configuration* (SQLite file, in-memory limiter) pins it to one writer/instance.

**D. Cannot scale horizontally today:** SQLite file; in-process rate limiter Map; (consequently) the chat endpoint's spend cap.

**E. What to change for substantially larger traffic (ordered):**
1. Run **Postgres mode** (already implemented) — removes the local-file ceiling.
2. **Externalize rate limiting** to Redis/PG (replaces the Map in `rate-limit.ts` — its header comment already says this is the intended swap).
3. Add **process-level scaling** behind a load balancer (app is otherwise stateless; cookies/sessions are DB-backed).
4. **Queue the LLM turns** (or at least add a global concurrency semaphore + cost budget) before the OpenAI tier limits become the bottleneck.
5. Fix **N+1s** (batch customer/order enrichment) and **index `audit_logs(timestamp)`**; add pagination caps where missing.
6. Introduce **caching** (e.g. read-through for hot orders/policies) and **observability** so limits are visible.

**F. Architectural vs configuration changes:** Postgres switch = **configuration only** (code exists). Rate-limiter swap, LLM queue, N+1 fixes, audit indexing, caching = **code changes**. Load balancer/containers/autoscaling = **infrastructure** (none exists in-repo — §26/§27).

**G. Load testing required to establish actual capacity:** (1) `k6`/Artillery script against `/api/chat` (mixed read/write agent turns, mock LLM to isolate app cost) ramping 1→100→500 VU, measuring p50/p95/p99 + error rate; (2) same against live LLM with a capped budget to find the provider knee; (3) DB-only stress on `/api/tickets`, `/api/approvals` (N+1 path) with 10k tickets; (4) concurrent `applyRefund` race test (idempotency under parallel approves); (5) login rate-limit behavior under proxy spoofing. None of these exist in the repo.

**H. Plausible production scaling architecture (PROPOSED — not current):**

```mermaid
flowchart LR
    LB[Load balancer / edge TLS] --> W1[Next.js instance 1]
    LB --> W2[Next.js instance N]
    W1 & W2 --> PG[(Postgres/Supabase<br/>managed, read replicas)]
    W1 & W2 --> R[(Redis<br/>rate limits, cache)]
    W1 & W2 --> OAI[OpenAI (rate-tiered,<br/>global semaphore)]
    subgraph async
        Q[(Job queue<br/>e.g. BullMQ/Postgres)] --> X[LLM worker pool<br/>agent turns, retries]
        W1 & W2 --> Q
    end
    OBS[Metrics/tracing/logs<br/>e.g. OpenTelemetry + host] -.-> W1 & W2 & X
```

Key deltas vs current: stateless app fleet (rate limit + hot reads in Redis), managed Postgres, **async LLM workers** (decouples the slow provider from request slots, adds retry/budget control), and an observability plane. Everything in this diagram is *new infrastructure/code* — none of it exists in the repository today.

---

## 23. RELIABILITY & FAILURE MODES

| Failure | Behavior (evidence-based) | Retry? | Fallback? | Notes |
|---|---|---|---|---|
| **DB unavailable** (SQLite file locked/missing, PG down) | Request → unhandled exception → generic 500 `{code:"INTERNAL"}` + full error in server log (`_util.ts`); dev server: better-sqlite3 throws on open at first request | no app-level retry | none | A missing `app.db` fails on first use (migrate/seed are manual steps); the app does **not** auto-create tables at boot |
| **LLM provider fails / times out** (live) | 60s `AbortSignal` → tool-level error "LLM request timed out." / "LLM request failed." → the agent loop reports the failure as a tool result and still returns a final message; user sees an error, **no fabricated answer** | none per-attempt (loop may call LLM again on next iteration ≤ max) | **none back to mock** (by design: a live deployment should not silently serve canned answers) | Verified logic in `openai.ts`; mock-mode has no such failure surface |
| **LLM returns garbage / unknown tool** | loop rejects unknown tool (audited `tool.rejected_unknown`), re-offers error; duplicate identical call rejected (dedupe guard); iteration cap (6) → "I hit my limit…" | n/a | bounded | VERIFIED (tool-routing tests, Eval 5) |
| **Network fails mid-request** | standard fetch/HTTP errors → 500 generic | none | none | — |
| **Malformed input** | Zod rejection → 400 at API; tool-level `VALIDATION_ERROR`/`TOOL_ERROR` envelope to the LLM (agent recovers) | none | safe | VERIFIED (validation tests, Eval 5) |
| **Server restart** | in-process rate-limit state lost (limits reset); **no other in-process state matters** (sessions/conversations/audit all durable in DB); SQLite WAL recovers cleanly | — | — | safe |
| **Concurrent requests** | SQLite: single-writer serialization (WAL); PG: row locks + unique idempotency key as backstop; **`applyRefund` is the only multi-row transaction and is atomic per driver** | — | — | double-approve race → idempotent no-op (VERIFIED: "execution is idempotent" test; race specifically **not** tested concurrently) |
| **Rate limit exceeded** | 429 with stable code `RATE_LIMITED` (login & chat) | client-side only | none | in-memory per process (§22) |
| **Credentials expire / quota exhausted** (OpenAI) | HTTP 4xx from provider → `Errors.tool("LLM request failed with HTTP …")` → agent reports failure accurately | none | none | status is generic (no 401-vs-429 special-casing) |
| **Approval TTL elapsed** | lazy expiry on read/decide (`maybeExpire`) → `APPROVAL_EXPIRED` error; customer sees stale pending until next read | — | — | no background sweeper (NOT IMPLEMENTED) |
| **Storage (disk) full** | unhandled DB error → generic 500 | — | — | no disk monitoring |
| **Idempotency** | refund execution: canonical key + DB unique index → exactly-once decrement (VERIFIED by test "retry the same approved refund"); approval creation: pending-dedupe key (VERIFIED) | — | — | strongest reliability property in the codebase |
| **Transaction safety** | single-row writes = atomic per statement; `applyRefund` = explicit transaction (sync/async per driver); no multi-step non-transactional write sequences found in the hot paths (approval decision + execution are two separate operations — approve-then-execute could leave `approved` without a completed refund if the process dies between them; recovery = admin re-decides? **No** — an already-`approved` approval cannot be re-decided, but `executeApprovedAction` is separately callable and idempotent; the UI's decision endpoint is the only executor path today, so a crash between the two calls strands an approved-but-unexecuted refund until manual intervention) | — | — | **gap worth knowing** (Medium) |

---

## 24. OBSERVABILITY & OPERATIONS

**Exists (VERIFIED in code):**
- **App-level audit log** — the standout: every authorization decision (yes/no + risk), tool call/result, ticket lifecycle, policy lookup, approval lifecycle, refund request/execution/failure → `audit_logs`, admin-visible in `/admin`. Secret-redacted.
- **Structured-ish console logs:** runtime-mode banner (once per process: LLM mode, data driver, iteration cap), `login_failed` (email+IP), `unhandled request error` (full stack, server-side only).
- **Error telemetry:** none (no Sentry/stackdriver/etc.).
- **Metrics:** none (no /metrics, no counters). **Tracing:** none (no request IDs, no OpenTelemetry). **Health checks:** none (no `/api/health`; platform-level port checks only).
- **Alerting:** none. Dashboards: none (the `/admin` audit tab is the only "dashboard" with operational data).

**What production operations would still require (not implemented):** a health/readiness endpoint (incl. DB connectivity probe); metrics + alerting (error rate, LLM latency/cost, queue depth if added, 429 rate, login-failure spikes); log shipping/structured logging; request IDs; a crash-restart policy (systemd/Docker/k8s) — none of which exist in-repo; DB backup/restore runbook (no tooling for it); capacity/load baselines (§22G).

---

## 25. BUILD, RUN & DEVELOPMENT WORKFLOW

**Prerequisites (verified):** Node **>= 22** (package.json engines); this assessment ran everything on **Node v24.19.0** — `better-sqlite3 ^13.0.3` must match the Node ABI (Node 24 ↔ ABI 137; a different Node major requires matching better-sqlite3 prebuilds). npm 10+ (lockfile). Playwright browsers for e2e (`npx playwright install chromium` once). **No Python, no Docker, no other runtimes needed.**

> Runtime note (environment-specific, not from the repo): on the original developer's machine the working Node lives at a custom path and must be first on `PATH` for commands to run under v24; any Node 22/24 that has `better-sqlite3` 13 prebuilds works.

**Verified command sequence (all executed in this assessment on the current tree):**

```bash
# 1. Install
npm install

# 2. Environment (optional — everything has offline defaults; .env.local is git-ignored)
cp .env.example .env.local     # placeholders only; leave empty = mock LLM + SQLite

# 3. Database (SQLite default)
npm run db:migrate             # applies .db/schema.sql (idempotent)
npm run db:seed                # seeds demo accounts/orders/tickets/approvals
npm run db:reset               # = migrate --reset (wipe file) + seed

# 4. Run
npm run dev                    # http://localhost:3000 (UI + API, one process)
npm run build && npm run start # production mode (boot gate enforces SESSION_SECRET)

# 5. Verification
npm run typecheck              # tsc --noEmit
npm run lint                   # next lint (deprecated in Next 16)
npm test                       # vitest: unit + integration + eval (11 files / 102 tests)
npm run eval                   # agent evaluations only
npm run test:e2e               # Playwright (auto: migrate --reset + seed --force + next dev :3000)
```

**Results executed in this assessment (Node v24.19.0):** install — already satisfied (lockfile present); `db:reset`/seed — verified via read-only DB inspection (5 customers, 6 orders in both `app.db` and freshly seeded `e2e.db`); vitest — **102/102 passed (48.8s)**; typecheck — **clean**; lint — **clean** (deprecation notice); build — **succeeded, 17 routes**; e2e — **2/2 passed on isolated re-run** (first run: core-flow 60s-timeout flake, support-dashboard passed — recorded in §19).

**Frontend-only/backend-only:** not applicable — one process serves both (README "Running the backend and frontend"; the API is the documented split boundary if decoupling ever becomes necessary).

**Gotchas observed:** (1) e2e `webServer` kills/restarts `next dev` and resets `data/e2e.db` — do not run e2e against a DB another process holds (Windows file lock → EPERM); (2) dev-server "Fast Refresh full reload" events are observed during e2e runs (routine, but they can cost test time); (3) the 60s per-test e2e timeout is tight on slow/cold machines.

---

## 26. DEPLOYMENT & INFRASTRUCTURE

### CURRENT IMPLEMENTATION (what exists in-repo)
- **Deployment model:** none defined. No Dockerfile, docker-compose, Helm, terraform, Pulumi, Vercel/Netlify config, or CI. The repo is "source + npm scripts"; deployment = manually: provision a Node host, copy repo, `npm ci`, configure env, `npm run db:migrate` (PG mode), `npm run build`, `npm start` (or dev).
- **Hosting assumptions (implicit):** a single always-on Linux/Windows host with Node ≥22 and a writable filesystem for SQLite (or an external Postgres). TLS/cookie `Secure` and HSTS preload headers **assume a TLS-terminating reverse proxy** (HSTS is only honored over HTTPS; `Secure` cookies are set in production — so **plain-HTTP production deployment would break login cookies**).
- **Reverse proxy:** assumed but unspecified; `clientIp()` reads `X-Forwarded-For` (see §17 Medium finding on trust).
- **Database hosting:** local file (SQLite) or external (Supabase/Postgres via `DATABASE_URL`). No migrations-in-pipeline step — a deploy must run `db:migrate` explicitly, and there is no versioned migration story (§10).
- **Rollback mechanisms:** none (no release artifacts, no DB rollback; a `git revert` + redeploy is the only path, and schema changes have no down-migrations).
- **Secrets management:** process environment / `.env` files. No vault integration. `SESSION_SECRET` is boot-required in production (good); `OPENAI_API_KEY`/`DATABASE_URL` expected in env.

### RECOMMENDED PRODUCTION ARCHITECTURE (what a production deployment would need — none of it exists yet)
- Container image (multi-stage: deps → build → runtime; note better-sqlite3 native build) or deploy to a Node platform **with Postgres mode enabled** (SQLite on a container = ephemeral-storage risk).
- TLS-terminating LB + at least 2 app instances (after the §22 changes) or a managed single-instance with auto-restart.
- Managed Postgres (Supabase fits the existing adapter) with the schema applied by a **pinned, versioned migration step in CI/CD**.
- Secrets in the platform's secret store (SESSION_SECRET, DATABASE_URL, OPENAI_API_KEY) — never in the repo.
- Health checks wired to a new `/api/health`; log/metrics export; DB backups + restore runbook; rate-limit store (Redis) if multi-instance.
- This is infrastructure + a small amount of code (§22 F) — the application code itself is deployment-ready behind a proxy.

---

## 27. CI/CD

**Current state: NOT IMPLEMENTED.** Verified by repo inspection: no `.github/workflows/`, no `.gitlab-ci.yml`, no `Jenkinsfile`, no `.circleci/`, no build pipelines anywhere; `package.json` has no CI scripts. The only "pipeline" is the manual command set in §25.

**Consequences (missing production gates):** no automated typecheck/lint/test/build gate on commit; no `npm audit` in any pipeline (advisory tracking was done manually in the security pass); no e2e in any pipeline; no deployment at all; no secret scanning; no branch protection configuration in-repo (GitHub-side settings cannot be verified from the repo — **UNKNOWN**).

**Recommended minimal CI (P1, §32):** a GitHub Actions workflow: `npm ci` → typecheck → lint → `npm test` → build → e2e (self-hosted runner or GitHub runner with browsers) → `npm audit --omit=dev` as a reported gate; tag-based deploy job later.

---

## 28. DEPENDENCY & VERSION HEALTH

**Lockfile:** `package-lock.json` present and current (modified in the working tree by the security pass's upgrades). `npm ci` is safe.

**Runtime dependencies (package.json, exact):**

| Package | Version | Role | Health notes |
|---|---|---|---|
| next | ^15.5.25 | framework | upgraded from 15.1.6 in the security pass (advisories); residual: nested `postcss` HIGH advisory — fix ships only in next 16.3.5 (deferred, build-time surface, documented in SECURITY_AUDIT.md) |
| react / react-dom | 19.0.0 | UI | stable release line |
| better-sqlite3 | ^13.0.3 | SQLite driver | **native; ABI-locked to Node major** (Node 24 ↔ v13 prebuilds). The single most fragile dep on runtime changes |
| drizzle-orm | ^0.45.3 | ORM | upgraded from 0.38.2 (HIGH advisory cleared) |
| postgres | ^3.4.9 | PG driver | pure JS, healthy |
| zod | 3.24.1 | validation | healthy (v4 exists; no breakage noted) |
| clsx | 2.1.1 | className | healthy |
| lucide-react | 0.469.0 | icons | healthy |

**Dev dependencies:** @playwright/test ^1.63.0 (upgraded from 1.50.1), vitest ^3.2.7 (upgraded), typescript 5.7.3, tsx 4.19.2, drizzle-kit 0.30.1 (unused by scripts), eslint 8.57.1 + eslint-config-next **15.1.6 (drift vs next 15.5.25)**, tailwind 3.4.17 / postcss 8.4.49 (root postcss is patched-clean; the advisory is next's *nested* copy), autoprefixer 10.4.20, @types/node **20.17.10 (behind runtime 24)**, @types/react 19.0.4, @vitejs/plugin-react 4.3.4, jsdom 26.0.0 (unused by test config), @types/better-sqlite3 9.6.0.

**Known vulnerabilities (verified by `npm audit` in the security pass, 2026-09-21):** production tree → only next's nested `postcss` HIGH (fix: next 16.3.5, deferred as a major bump); dev tree → `esbuild` (transitive via tsx/vite/drizzle-kit) and `@vitest/mocker` (fixed in vitest 5, breaking) — both dev-only, no runtime exposure. Full record: `SECURITY_AUDIT.md` remediation table.

**Incompatible/conflicting:** none observed (install + build + tests all green under Node 24). **Duplicates:** `postcss` (root 8.4.49 vs next's nested copy) — expected in the Next ecosystem, not a defect. **Suspicious:** none beyond the `allowScripts` accommodation block (host-environment artifact, §4).

---

## 29. DOCUMENTATION VS REALITY

The README (554 lines) is unusually good — most claims verify against code. Deltas found:

| Claim (README) | Documentation Says | Code Actually Does | Status | Evidence |
|---|---|---|---|---|
| "production-style … production-oriented" | implies prod-ready | no CI, no containers, no observability, no real integrations live-verified, no user provisioning | **PARTIALLY TRUE** — "production-oriented" = fail-closed config defaults; not a production *system* | §26, §27, §24, §13 |
| "No API key? No problem… runs fully offline" | mock + SQLite default | exactly that (verified: boots and E2E-passes with zero env) | **VERIFIED TRUE** | e2e webServer env, this assessment's runs |
| "Add keys… automatically switches… no code change" | auto-switch LLM & DB | factory + getRepo auto-select (verified in code; runtime-switch with real creds NOT verified) | **IMPLEMENTED, NOT RUNTIME-VERIFIED** | `llm-factory.ts`, `client.ts`, README's own "Not verified here" notes |
| Project structure tree | lists `support/` routes, `api/tickets` | tree omits: `src/app/support/page.tsx`, `api/tickets/**`, admin/support layouts, `src/instrumentation.ts`, `lib/rate-limit.ts`, `src/components/` | **OUTDATED** (pre-dates support dashboard + security pass) | §5 (actual tree) |
| "Testing & evaluation … 10-scenario agent eval" | 10 scenarios | `agent-eval.test.ts` has **18** + `staff-chat.eval.test.ts` has **8** (26 total) | **STALE COUNT** | test files (read) |
| "E2E — … admin uses Chat (the 'admin chat does nothing' regression) and a customer lookup works" | describes e2e coverage | current `core-flow.spec.ts` covers login→order→refund→approve→confirm; that specific admin-chat regression step is not in the current spec body; support-dashboard spec covers dashboard + lockout | **PARTIALLY STALE** | both spec files (read) |
| Env table: `APP_URL` "used in audit/notifications where applicable" | implies runtime use | **no code path reads APP_URL** (no notifications exist either) | **FALSE/ASPIRATIONAL** | src grep: no usage |
| "Refund … 5-10 business days on original payment method" (KB text) | implies real money movement | refunds are DB-only simulations | **MOCK** (by design; KB text is demo copy) | `refund-execution.ts`, `knowledge.ts` |
| `db:reset` "(SQLite)" | reset is SQLite-only | `migrate.ts --reset` documented as SQLite-only (PG reset = manual) | **VERIFIED TRUE** | `migrate.ts` header |
| Security section (boot gate, rate limits, CSP, page gates, PBKDF2 600k, 0600 perms) | detailed | all verified in code + unit tests + earlier production smoke | **VERIFIED TRUE** | §17, `security-hardening.test.ts`, SECURITY_AUDIT.md |
| ".env.example contains placeholders only" | yes | true; additionally committed `.env.test` is **dead** (loaded by nothing, points at a different DB path) | **TRUE + STALE ARTIFACT** | `.env.test`, `tests/setup.ts`, `playwright.config.ts` |
| "30-day return window" (policy prose, KB) | general 30-day window | code enforces the 30-day window **only for full refunds**; partial refunds are amount-limited | **DIVERGENT** | `refunds.ts:76-87` vs `knowledge.ts` |

---

## 30. KNOWN ISSUES, RISKS & TECHNICAL DEBT

Consolidated register (security items cross-ref §17; actions are recommendations — **none implemented in this task**):

| # | Severity | Area | Problem | Evidence | User/business impact | Technical impact | Recommended action |
|---|---|---|---|---|---|---|---|
| 1 | **High** | VCS/security | DB sidecar files (hashes, sessions, audit) committed in git history; repo has a GitHub remote | `git log --stat` | credential/session compromise exposure | history rewrite + credential rotation required | owner: filter-repo/fresh repo, reseed, revoke (manual) |
| 2 | **High** | Integrations | No real order/payment/tracking/notification providers; business data is seeded | §15 | cannot serve real customers without new subsystems | major new development | roadmap decision: build ingestion+payments or reposition as reference architecture |
| 3 | **Medium** | Ops | No user provisioning (registration/password reset/deletion) | §12 | no real-user lifecycle | new features | add SSO or registration |
| 4 | **Medium** | Ops | No CI/CD, containers, health endpoint, metrics, backups | §24–27 | undeployable at scale; silent failures | new tooling | P1 workstream |
| 5 | **Medium** | Scalability | SQLite default + in-process rate limiter bound app to one instance | §22 | capacity ceiling | config (PG) + code (limiter) | §22 E |
| 6 | **Medium** | Security | XFF trusted unconditionally for login rate limiting | `_util.ts:38-42` | bucket-spoofing behind proxy | small code fix | proxy allowlist |
| 7 | **Medium** | Reliability | Crash between approve and execute strands approved-but-unexecuted refund (approved is terminal for re-decide; executor idempotent but reachable only via the decision endpoint) | `approvals.ts`, decision route | stuck refunds needing manual DB fix | small code fix | add idempotent "execute" admin action |
| 8 | **Medium** | Data | No retention/purge for messages, audit, tickets, expired sessions; audit unindexed | §10, §18 | growth, privacy | schema + jobs | retention policy + index |
| 9 | **Low** | Devex | e2e 60s test timeout flakes on cold dev servers; "Fast Refresh full reload" during runs | §19, this assessment's run #1 | flaky CI later | raise timeout / pre-warm | config |
| 10 | **Low** | Code | 4-way schema sync (2 DDL + 2 Drizzle) with no migration framework; `mapTicket` duplication; N+1 enrichment loops; loose `any` in UI state | §10, §20, §21 | drift risk at first schema change | consolidation | refactor when schema changes |
| 11 | **Low** | Deps | eslint-config-next drift; @types/node behind; stale `.env.test`; unused jsdom/drizzle-kit; `APP_URL` dead | §4, §29 | migration noise | trivial cleanup | housekeeping |
| 12 | **Low** | Privacy | `images/*.jpg` demo PII in a remote repo; audit results JSON carries PII | §17 | public PII hygiene | replace images; extend redaction | manual review |
| 13 | **Info** | Process | Working tree dirty (security pass uncommitted) — HEAD ≠ running code | `git status` (§25) | anyone cloning HEAD gets the *pre-hardening* app | — | commit the security pass |

---

## 31. PRODUCTION READINESS GAP ANALYSIS

**Bottom line: the application is NOT safe to operate in production for real users today.** Gaps, separated by nature:

- **Code (requires code changes):** user provisioning (registration/reset/deletion); real order data ingestion; payment/refund provider integration; carrier tracking; notifications; `/api/health` + metrics; rate-limiter externalization; XFF trust fix; approve/execute crash recovery; retention jobs; audit index; e2e timeout hardening.
- **Security (mostly configuration + one manual action):** **git-history purge + credential/session rotation (manual, High)**; real secrets in a secret store; black-box pen test (from SECURITY_AUDIT.md manual items); screenshot PII review.
- **Infrastructure (external setup, no code):** TLS-terminating reverse proxy (mandatory — `Secure` cookies + HSTS assume TLS); managed Postgres (recommended over SQLite in prod); load balancer + ≥2 instances (after code gaps); restart policy (systemd/container); backups.
- **Credentials (external):** OpenAI key + account/tier; Supabase/Postgres project; (optional) Redis.
- **Database:** versioned migration process; backup/restore runbook; Supabase-side RLS/permissions review (manual, per audit).
- **Scalability:** §22 E–H (mostly configuration/infrastructure + limiter code).
- **Reliability:** monitoring + alerting; provider budget/concurrency caps; concurrent-approve race test.
- **Monitoring:** nothing exists (§24) — the largest single operational gap.
- **Testing:** live-provider tests; load tests; CI gates.
- **Deployment:** the entire §26 recommended architecture + §27 CI/CD.
- **Privacy/compliance:** retention, deletion, DPA for the LLM provider, consent — if real personal data is used (§18).
- **Operational processes:** runbooks, secret rotation, incident response — none exist (out of repo scope, but required).

**Minimum bar to "safely operate":** git-history purge + rotation, user provisioning, TLS proxy + real secrets, managed Postgres + migration process, health checks + log/metric export, CI gate. Everything else is scale/quality, not safety-critical.

---

## 32. ROADMAP / RECOMMENDED NEXT STEPS

Priorities = engineering remediation urgency (not a project score). **Nothing here was implemented.**

**P0 — blockers (safety before traffic):**
1. **Purge git history + rotate everything** (issue 1). Why: committed hashes/sessions in a remote repo. Code: no. External: owner action + force-push. Dependencies: none.
2. **Commit the security-hardening working tree** (issue 13). Why: HEAD is the pre-hardening state. Code: no (just commit).
3. **User provisioning path** — minimal registration with strong password policy + admin user management. Why: without it, "production" means hardcoded demo accounts (seeded hashes are `demo1234`). Code: yes. External: no.
4. **TLS + proxy + real secrets** deployment skeleton. Why: Secure-cookie/HSTS/audit assumptions. Code: no. External: yes (infra).

**P1 — important before production:**
5. **CI/CD pipeline** with typecheck/lint/test/build/e2e/audit gates (issue 4). Code: yes (workflow files). External: runner.
6. **Observability baseline:** `/api/health`, structured logging + export, basic metrics + alerts on 5xx/429/login-failures (issue 4). Code: yes.
7. **Postgres as the default prod data path** + versioned migrations + backup runbook (issues 5, 8). Code: small. External: Supabase/managed PG.
8. **OpenAI live validation:** run e2e + evals against a real key in staging; confirm tool-call quality on the chosen model; set budget/concurrency caps (unverified live path). Code: small. External: key.
9. **XFF trust fix + rate-limiter externalization** if multi-instance/proxied (issue 6). Code: small.
10. **approve/execute crash-recovery** (issue 7). Code: small.

**P2 — important improvements:**
11. Real order ingestion + real refund processor integration (issue 2). Code: substantial. External: payment provider.
12. Retention/purge + audit indexing + redaction review (issues 8, 12). Code: medium.
13. Live-provider tests in CI (OpenAI + Postgres) with secrets; concurrent-approve race test. Code: medium.
14. N+1 fixes, mapper consolidation, UI type tightening (issue 10). Code: medium.
15. Carrier tracking + email notifications (issue 2). Code + external.

**P3 — optional/future:**
16. Next 16 upgrade (clears nested postcss advisory; `next lint` → ESLint CLI). Code: migration effort.
17. Redis caching; async LLM worker queue (§22 H). Code: substantial.
18. SSO (OAuth/OIDC) instead of passwords. Code + external.
19. Policy/limits UI; multi-tenancy (not designed today).

---

## 33. ASSUMPTIONS & UNVERIFIED ITEMS

Everything that could **not** be established from the repository (explicit):

1. **OpenAI integration never run with a real key** — no in-repo evidence; README concedes it. Live-model tool-call quality: UNKNOWN.
2. **Postgres/Supabase adapter never run against a live instance** — README concedes it; real-instance RLS/network behavior: UNKNOWN.
3. **Git remote visibility** — remote is `github.com/Karan7505/AI-Customer-Support-Agent.git`; public vs private, and whether history containing the WAL files was ever pushed: **cannot verify from the repo** (treat as pushed = compromised per issue 1).
4. **GitHub-side settings** (branch protection, Actions, secret scanning): not visible from the repo.
5. **No load/performance baselines exist** — all §22 capacity statements are structural reasoning, not measurements.
6. **better-sqlite3 prebuilds on the target deployment platform** (distro/musl specifics) — not verified; native modules can fail where the dev machine succeeded.
7. **Next.js font download behavior when offline at build time** — not exercised here.
8. **Business decisions not in code:** rationale for 72h approval TTL, 60 turns/10min, 30-day window for full refunds only, absence of an email step — inferred from code/comments; no product spec exists in the repo.
9. **The 5-commit history is not the full development history** — the working tree holds a large uncommitted security pass; `git log` shows 5 events.
10. **Deployment target, team, SLOs, budget:** nothing in the repo indicates intended hosting, team size, or operational SLOs.
11. **`.env.test`'s intent** — whether a planned loader existed and was dropped: UNKNOWN (the file is dead as-is).
12. **`allowScripts` block in package.json** — a host-environment accommodation whose exact toolchain origin cannot be verified from the repo.

---

## 34. SENIOR ENGINEER HANDOVER CHECKLIST

Based solely on this document's content:

- [x] What the application does — §1
- [x] Who it serves — §1–2 (three roles, one table)
- [x] Every major feature — §2 (incl. explicit NOT-IMPLEMENTED list)
- [x] Major user journeys — §3 (5 flows, one diagrammed end-to-end)
- [x] Complete tech stack — §4 (versions, rationale, outdated items)
- [x] Repository structure — §5 (annotated tree, entry points)
- [x] Architecture — §6 (diagram, trust boundaries, rationale)
- [x] Frontend architecture — §7
- [x] Backend architecture — §8
- [x] APIs — §9 (12-endpoint inventory + agent tool inventory)
- [x] Database/data model — §10 (ER diagram, DDL-verified, integrity risks, live row counts)
- [x] Data lifecycle — §11 (per-category table, trust boundaries)
- [x] Authentication — §12
- [x] Authorization — §12 (role matrix, isolation, gaps)
- [x] External integrations — §13 (classified inventory)
- [x] Required credentials — §13–14 (table; no secret values anywhere in this doc)
- [x] Mock vs live functionality — §15 (component-by-component)
- [x] Business rules — §16 (rules, constants, code locations)
- [x] Security posture — §17 (verified controls + graded findings)
- [x] Privacy considerations — §18
- [x] Test coverage — §19 (inventory + executed results + gaps)
- [x] Code quality — §20
- [x] Performance characteristics — §21 (measured vs theoretical separated)
- [x] Current scalability — §22 A–D
- [x] Scaling bottlenecks — §22 B
- [x] Future scaling requirements — §22 E–H (PROPOSED diagram labeled as such)
- [x] Reliability/failure modes — §23 (13 scenarios)
- [x] Observability — §24 (exists vs required)
- [x] Local development procedure — §25 (verified commands + results)
- [x] Deployment architecture — §26 (current vs recommended)
- [x] CI/CD — §27 (absent + recommended)
- [x] Known issues — §30 (13-item register)
- [x] Technical debt — §20, §30
- [x] Production-readiness gaps — §31 (categorized; code vs external)
- [x] What requires code changes — §31–32 (flagged per item)
- [x] What requires credentials/external setup — §31–32 (flagged per item)
- [x] Recommended next steps — §32 (P0–P3)
- [x] What remains unknown — §33 (12 explicit items)

---

## 35. FINAL HANDOVER SUMMARY

1. **What exactly is this application?** A single-process Next.js 15 + TypeScript "agentic" customer-support system for a fictional e-commerce brand: the LLM proposes tools; deterministic code authorizes, risk-classifies, approval-gates, and executes; every significant action is audited.
2. **What does it currently do?** Role-gated chat (orders, mock tracking, tickets, policy answers), refund requests into a human-approval workflow with idempotent simulated execution, a staff ticket dashboard, an admin approvals+audit console — on SQLite (default) or Postgres, mock LLM (default) or OpenAI-compatible.
3. **What is actually verified to work?** The entire mock+SQLite path, re-verified in this assessment: 102/102 vitest, clean typecheck/lint, green production build (17 routes), 2/2 Playwright E2E on an isolated run, read-only DB inspection matching the seed. Security controls verified by dedicated unit tests and (earlier, same session) a production-mode smoke.
4. **What is mocked/unverified/incomplete?** Mock: LLM planner (default), tracking, refund execution, seeded business data, static KB. Runtime-unverified: live OpenAI, live Postgres/Supabase. Absent: registration, payments, notifications, real order ingestion, CI/CD, containers, health/metrics/tracing, retention, load tests, deployment tooling.
5. **What technology does it use?** Node ≥22 (verified v24.19.0), Next.js 15.5.25, React 19, TypeScript 5.7, Tailwind 3.4, Drizzle 0.45.3 over better-sqlite3 13 / postgres-js 3.4, Zod 3.24, raw OpenAI-compatible fetch (no SDK), Vitest 3.2.7, Playwright 1.63, tsx, ESLint 8.
6. **How is it architected?** One Node service: React client pages → JSON API (cookie sessions) → agent loop → policy/tools/approvals/audit (pure TS) → single async Repo interface → SQLite or Postgres. The LLM is a swappable, untrusted component; two trust boundaries (browser→API, LLM→app).
7. **Where and how is data stored?** 9 tables (customers, orders, support_tickets, refunds, approval_requests, audit_logs, sessions, conversations, messages); integer cents, epoch ms, JSON columns; SQLite file `./data/app.db` (0600) by default or Postgres via `DATABASE_URL`; seeded by script; nothing auto-created at boot.
8. **Which external services does it depend on?** None required (fully offline default). Optional: OpenAI-compatible LLM (key), Supabase/Postgres (connection string). Google Fonts at build time. No payments/email/tracking/analytics providers exist.
9. **What are the major security risks?** (1) Committed DB sidecars in git history with a remote (High — manual purge/rotation); (2) no user-provisioning lifecycle (Medium); (3) XFF-trusted login rate limiting (Medium); (4) unbounded PII-bearing audit/messages, no retention (Medium–Low); plus accepted/documented items (unsafe-inline CSP, in-memory limiter). Graded list: §17.
10. **What are the major technical risks?** No deployment/CI/observability substrate; SQLite single-writer ceiling; 4-way schema sync without a migration framework; untested live-provider paths; the 706-line mock planner as de-facto offline behavior spec; dirty working tree (HEAD ≠ running code).
11. **Can it scale, and what are the bottlenecks?** Modest scale (tens of concurrent users) on one instance. Bottlenecks in order: SQLite writes + sync driver, N+1 list enrichment, per-customer LLM spend vs provider tiers, unindexed audit scans (§22).
12. **What prevents substantially larger scale?** The SQLite file, in-process rate limiter, inline LLM calls, and absent caching/queues/replication — fixed by PG mode (exists), shared limiter (code), async LLM workers (new), LB (infra) (§22 E–H).
13. **What prevents production operation?** Git-history purge + rotation (manual), user provisioning, TLS proxy + real secrets, managed Postgres + migration process, health/metrics/alerting, CI gates — and, for real business use, the missing business integrations (§31).
14. **What should the next engineer work on first?** P0 in order: (1) history purge + rotation, (2) commit the uncommitted security pass, (3) user provisioning, (4) TLS/secrets deployment skeleton — then P1: CI, observability baseline, Postgres+migrations, live-OpenAI validation (§32).
15. **What could not be established?** §33 — 12 explicit items, headlined by live OpenAI/Postgres behavior, the repo's visibility/push state (i.e., whether the sensitive history is exposed), all performance numbers (no load tests exist), and product-decision rationale absent from the repo.

*End of handover document. All commands cited in §19/§25 were executed in this assessment unless otherwise noted; all file references point at the working tree as of 2026-09-23.*
