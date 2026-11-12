# Invoice AP & AR Management System — Design

This document covers the five pre-build steps: requirements analysis, system architecture,
database schema, accounting logic and the development roadmap.

---

## 1. Requirements analysis

| Area | Requirement | Design decision |
|---|---|---|
| Users | Internal finance team + management (read-only) | Three roles: **admin**, **finance**, **viewer**. Enforced in the database (RLS + triggers), not only in the UI. |
| AP | Supplier invoices, approval, payments, partial payments | AP invoices carry a separate **approval status**. A payment can be recorded only once an invoice is approved (a standard AP control). |
| AR | Customer invoices, collections, partial collections, overdue tracking | Same invoice/payment engine as AP, with customer-facing labels ("Received", "Collection status"). |
| Amounts | Invoice amount + tax = total | `total_amount` is a **generated column** in the database, so it can never disagree with its parts. A Malaysian SST helper (6 % / 8 % / 10 %) fills the tax field. |
| Balances | Paid / outstanding | **Never stored.** Always derived from payment records, so no figure can drift out of sync. |
| Dashboard | KPIs, monthly trends, recent activity | Computed from invoice + payment rows at request time. No totals are hard-coded or cached. |
| Aging | Current, 1–30, 31–60, 61–90, 90+ days | Based on outstanding balance and days past the due date. |
| Integrity | No duplicate invoice numbers, no overpayment | Unique indexes plus a row-locking trigger in Postgres. The UI checks the same rules first to give friendly messages. |
| Currency | MYR | Amounts are `numeric(14,2)` in the database and **integer sen** in TypeScript, so no floating-point rounding errors. Displayed as `RM 1,234.50`. |
| Audit | Recent activity | An `activity_log` table filled by **database triggers**, so every change is recorded however it was made. |
| Demo | Realistic sample data | A seeded Supabase database, plus a **demo mode** that runs fully in the browser when no Supabase project is configured. |

### Interpretation notes

* **Duplicate invoice numbers.** AR numbers are issued by us, so they must be unique across all AR
  invoices. AP numbers are issued by suppliers, and two suppliers can both send "INV-001", so AP
  numbers must be unique **per supplier**. Both checks ignore letter case and surrounding spaces.
* **"Approved" vs payment status.** As requested, approval is kept separate from payment status:
  * Approval status (AP only): `Pending approval` → `Approved` / `Rejected`
  * Payment status (derived): `Pending`, `Partially Paid`, `Paid`, `Overdue`, `Cancelled`

  The AP list can be filtered by either one, so "Approved" remains a filter option.
* **Overdue vs Partially Paid.** Both formulas can be true at once (part paid, past due).
  The displayed status uses this priority: **Cancelled > Paid > Overdue > Partially Paid > Pending**.
  Overdue is the bigger risk, so it wins. A "part paid" marker is still shown next to it.
* **Cancelling.** An invoice that has payments cannot be cancelled. Reverse the payments first, so the
  books stay consistent. Cancelled invoices are excluded from every total.

---

## 2. System architecture

```
┌──────────────────────── Frontend (React + TypeScript + Tailwind) ────────────────────────┐
│  features/  Pages: Dashboard · AP · AR · Aging · Login                                   │
│  components/ Reusable UI: Button, Card, StatCard, DataTable, Badge, Modal, FormField…     │
│        │ uses                                                                            │
│  domain/   PURE business logic, no I/O: money · invoice status · aging · dashboard · CSV  │
│        │                       validation (zod)                                          │
│  data/     Repository interface ──► SupabaseRepository (production)                       │
│                                └──► DemoRepository     (in-browser sample data)           │
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                             │ supabase-js (HTTPS, JWT)
┌──────────────────────── Backend (Supabase) ┴─────────────────────────────────────────────┐
│  Auth (email + password) · PostgREST API · Row Level Security policies                    │
│  Triggers: overpayment guard · approval guard · cancel guard · audit log · updated_at     │
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
┌──────────────────────── Database (PostgreSQL) ─────────────────────────────────────────────┐
│  profiles · counterparties · invoices · payments · activity_log  (supabase/migrations)    │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Frontend** renders the UI and never talks to Supabase directly. Pages call the repository.
* **Domain** is plain TypeScript functions. It holds every formula, is shared by both repositories,
  and is fully unit-tested.
* **Backend/database** is the source of truth. It enforces security and integrity even if someone
  bypasses the UI and calls the API directly.
* Data fetching uses TanStack Query (caching, refetch after mutations). Routing uses React Router.

### Folder layout

```
supabase/migrations/   SQL schema, triggers, RLS (run in order)
supabase/seed.sql      realistic sample data (generated from src/data/sampleData.ts)
supabase/tests/        SQL integration tests (run against Postgres)
scripts/               seed generator, SQL test runner
src/domain/            money, dates, invoice calculations, aging, dashboard, validation, csv
src/data/              repository interface + Supabase and demo implementations
src/components/        reusable UI components
src/features/          pages (dashboard, invoices, aging, auth)
e2e/                   Playwright end-to-end tests
```

---

## 3. Database schema

```
auth.users (Supabase)
   │ 1:1
profiles ─ id (uuid, PK, FK auth.users) · full_name · role (admin | finance | viewer)

counterparties ─ id · kind (supplier | customer) · name · email · phone
                 UNIQUE (kind, lower(name))
   │ 1:N
invoices ─ id (uuid)
           invoice_type        'AP' | 'AR'
           invoice_number      text, required
           counterparty_id     FK → counterparties   (kind must match: AP→supplier, AR→customer)
           invoice_date, due_date                    CHECK due_date ≥ invoice_date
           description
           invoice_amount      numeric(14,2) ≥ 0
           tax_amount          numeric(14,2) ≥ 0
           total_amount        GENERATED = invoice_amount + tax_amount
           approval_status     AP: pending | approved | rejected;  AR: NULL
           is_cancelled, cancelled_at, cancel_reason
           created_by, updated_by, created_at, updated_at
           UNIQUE AR:  lower(trim(invoice_number))                 WHERE invoice_type = 'AR'
           UNIQUE AP:  (counterparty_id, lower(trim(invoice_number))) WHERE invoice_type = 'AP'
   │ 1:N  (ON DELETE RESTRICT: an invoice with payments cannot be deleted)
payments ─ id · invoice_id · payment_date · amount numeric(14,2) > 0 · method · reference · notes
           created_by · created_at

activity_log ─ id · invoice_id · action · summary · actor_id · actor_name · created_at

VIEW invoice_balances (security_invoker) ─ invoice + amount_paid + outstanding_balance (for SQL reporting)
```

### Database-enforced rules (triggers)

| Trigger | Rule |
|---|---|
| `payments_guard` | Locks the invoice row (`FOR UPDATE`) so two payments can't race. Rejects a payment if it would push total payments above `total_amount`, if the invoice is cancelled, or if an AP invoice is not approved. |
| `invoices_guard` | Rejects lowering the total below what has already been paid, cancelling an invoice that has payments, or a change of approval status by anyone but an admin. Fixes `invoice_type` after creation. |
| `audit_*` | Writes one `activity_log` row for every invoice create, edit, approve or cancel, and every payment recorded or reversed. |

### Row Level Security

| Table | viewer | finance | admin |
|---|---|---|---|
| invoices, payments, counterparties, activity_log | read | read + create + update | everything, plus delete |
| Approve / reject AP | ✗ | ✗ | ✓ |
| profiles | own row | own row | all rows, can change roles |

New sign-ups automatically get the **viewer** role (safe default). An admin promotes them.

---

## 4. Accounting logic

All money is handled as **integer sen** (RM 1.00 = 100 sen) in TypeScript.

```
Total Amount        = Invoice Amount + Tax Amount
Total Payments      = Σ payments.amount for the invoice
Outstanding Balance = Total Amount − Total Payments            (never below 0; the DB forbids overpaying)
Overdue             = Outstanding > 0 AND Today > Due Date AND not cancelled
Days Overdue        = Today − Due Date     (when overdue, else 0)

Payment status (first matching rule wins):
  1. Cancelled       invoice is cancelled
  2. Paid            Outstanding = 0
  3. Overdue         Outstanding > 0 AND Today > Due Date
  4. Partially Paid  Total Payments > 0 AND Outstanding > 0
  5. Pending         no payment yet, awaiting processing

Aging bucket (open, non-cancelled invoices with Outstanding > 0, measured on the Outstanding):
  Current      Days Overdue = 0  (due today or later)
  1–30         1 ≤ Days Overdue ≤ 30
  31–60        31 – 60
  61–90        61 – 90
  90+          > 90
```

"Today" is computed in the company time zone (**Asia/Kuala_Lumpur**), not the browser's,
so an invoice becomes overdue at the same moment for everyone.

### Dashboard formulas (cancelled invoices excluded throughout)

| KPI | Formula |
|---|---|
| Total AP / AR Outstanding | Σ Outstanding of AP / AR invoices |
| Total AP Paid / AR Collected | Σ payments recorded against AP / AR invoices (plus "this month") |
| Overdue AP / AR | Σ Outstanding of overdue AP / AR invoices (plus count) |
| Monthly trends (last 12 months) | Per calendar month: Σ total_amount by `invoice_date` (invoiced) and Σ payment amount by `payment_date` (cash paid / collected) |
| Recent activity | Latest 10 rows from `activity_log` |

---

## 5. Development roadmap

| Phase | Deliverable | Verification |
|---|---|---|
| 0 | This design document | Review |
| 1 | Project scaffold and **domain layer** (money, status, aging, dashboard, trends, CSV) | Vitest unit tests on every formula and edge case |
| 2 | **Supabase migrations**: schema, triggers, RLS, seed data | SQL integration tests on a real PostgreSQL 16 (duplicates, overpayment, approval, RLS per role) |
| 3 | **Data layer**: repository interface, Supabase repository, demo repository, zod validation | Vitest tests covering the demo repository's business rules |
| 4 | **UI**: navy layout, dashboard + charts, AP module, AR module, aging report, payment recording, CSV export, login | Type-check, production build, manual run |
| 5 | **End-to-end**: Playwright drives every button and flow, checks figures against the domain layer; desktop and mobile screenshots; README | `npm run test:e2e`, then commit |
