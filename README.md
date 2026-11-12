# Invoice & AP/AR Payment Tracker

A small, self-hosted website to track company invoices and their payment status:

- **Receivables (AR)** – invoices you issue to customers (money owed to you)
- **Payables (AP)** – bills from suppliers (money you owe)

Your boss gets a **read-only Viewer account**: they sign in from any phone or computer and see
the live dashboard every day, but can't change anything.

## Features

- **Dashboard**: AR / AP outstanding, overdue amounts, net position, cash collected and paid out
  this month, aging buckets (current, 1–30, 31–60, 61–90, 90+ days), most-overdue list,
  what's due in the next 7 days, and a recent-activity feed (who changed what, and when).
- **Automatic status** per invoice: Open, Partially paid, Overdue, Paid, Void — worked out from the
  due date and the payments you record, so it's never out of date.
- **Payments**: record full or partial payments (date, method, reference). Overpayments are blocked.
- **Search, filter, sort**, and totals on every list. Works well on phones.
- **CSV import** (from Excel / Google Sheets) and **CSV export**.
- **Users & roles**
  | Role   | Can do |
  |--------|--------|
  | Viewer | See everything, export CSV. Read-only. **← give this to your boss** |
  | Editor | + add/edit invoices, record payments, import CSV |
  | Admin  | + delete invoices, manage users, company name & currency |
- Secure sign-in (scrypt-hashed passwords, HttpOnly session cookies, login rate limiting).
- No external dependencies: one Node.js process and a single SQLite file.

## Run it locally

Requires **Node.js 22.5 or newer**.

```bash
ADMIN_PASSWORD='choose-a-strong-password' npm start
# open http://localhost:3000 and sign in as "admin"
```

If you don't set `ADMIN_PASSWORD`, a random one is printed in the console on first start.
Data is stored in `data/invoices.db`.

Run the tests with `npm test`.

## Getting started

1. Sign in as `admin`. Go to **Account** and set your company name and currency (e.g. `MYR`, `SGD`, `USD`).
2. Add invoices under **Receivables** / **Payables**, or click **Import CSV** (a template is provided).
3. Go to **Users → Add user**, create an account for your boss with role **Viewer**,
   and send them the website link plus their username and password.
4. When a customer pays you (or you pay a supplier), open the invoice and **Record payment**.

## Putting it online so your boss can open it

The site needs to run on a server with a **persistent disk** (so the database isn't lost on restart)
and **HTTPS**. Any of these work:

### Option A – Render (easiest)
1. Push this repo to GitHub (already done if you're reading this there).
2. On [render.com](https://render.com) choose **New → Blueprint** and select this repository.
   `render.yaml` sets up the web service and a 1 GB disk.
3. Enter an `ADMIN_PASSWORD` when asked, deploy, and open the `https://…onrender.com` URL.

### Option B – Any VPS / office server with Docker
```bash
docker build -t invoice-tracker .
docker run -d --name invoice-tracker --restart unless-stopped \
  -p 3000:3000 -v invoice-data:/data \
  -e ADMIN_PASSWORD='choose-a-strong-password' \
  -e TIMEZONE='Asia/Kuala_Lumpur' -e SECURE_COOKIES=true \
  invoice-tracker
```
Put it behind a reverse proxy with HTTPS (e.g. Caddy: `caddy reverse-proxy --from invoices.yourcompany.com --to :3000`).

Railway, Fly.io and similar platforms also work — just mount a volume at `/data`.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATABASE_FILE` | `data/invoices.db` | SQLite database location |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | `admin` / random / `Administrator` | First admin account (only used when there are no users yet) |
| `TIMEZONE` | `UTC` | Company time zone, used to decide what is "today" / overdue |
| `CURRENCY` | `USD` | Default currency until set in the app |
| `SECURE_COOKIES` | `false` | Set to `true` when served over HTTPS |

### Backups
Everything lives in one file (`invoices.db`). Copy it regularly (e.g. a daily cron job, or your host's
disk snapshots). The CSV export is also a handy human-readable backup.
