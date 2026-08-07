# ⚡ VaultixPOS v2

Multi-tenant SaaS Micro-POS & Inventory Management  
**Stack:** Node.js · Express · EJS · PostgreSQL · Bootstrap 5 RTL · GSAP 3

---

## What's New in v2

| Fix / Feature | Details |
|---|---|
| **Bug: Redirect loop fixed** | `checkSubscription` middleware always fetches live status from DB — never stale session data |
| **Bug: Logout always reachable** | `/logout`, `/login`, `/support`, `/pending`, `/expired` are fully exempt from subscription checks |
| **No auto-trial on register** | New accounts get `status = 'pending'` and are redirected to `/pending` page |
| **`/pending` page** | Elegant activation-pending page with WhatsApp CTA and status-refresh button |
| **`/expired` page** | Elegant expired page with WhatsApp, refresh-status, and logout buttons |
| **Dashboard: 4 stat cards** | Today's Sales, Monthly Revenue, Low Stock Count, Total Products |
| **Dashboard: Product tabs** | Products tab + Sales History tab with GSAP-animated switching |
| **Dashboard: Search & Filter** | Real-time client-side filter by name, SKU, category, or status |
| **Dashboard: Edit & Delete** | Edit Price/Stock/Category/SKU inline; delete with confirmation modal |
| **Dashboard: Export Report** | Opens a printable daily sales report in a new window |
| **Dashboard: WhatsApp widget** | Floating pulsing WhatsApp button for client support |
| **Dashboard: Admin notifications** | Dismissable in-app banner messages sent from admin panel |
| **Admin: Online indicator** | Green pulsing dot for stores active in the last 15 minutes |
| **Admin: Extend days modal** | Add +3/7/30/90/365 or custom days to any store's subscription |
| **Admin: 5 status options** | pending · trial · active · expired · lifetime |
| **Admin: Send notification** | Push a custom message banner to any store's dashboard |
| **Admin: WhatsApp config** | Edit/copy admin WhatsApp number directly from the panel |
| **DB: `last_seen` tracking** | Updated on every authenticated request via middleware |
| **DB: `notifications` table** | Stores admin-to-client messages |
| **DB: `admin_config` table** | Platform-level key-value settings (WhatsApp number, etc.) |
| **DB: `category` + `sku`** | New fields on `products` table |

---

## Quick Start

```bash
git clone <repo> && cd vaultixpos
npm install
cp .env.example .env        # Fill in DATABASE_URL + SESSION_SECRET
npm run db:init             # Runs schema_v2.sql against your Postgres DB
npm run dev                 # Starts on http://localhost:3000
```

---

## Project Structure

```
vaultixpos/
├── views/
│   ├── login.ejs           ← Auth sign-in
│   ├── register.ejs        ← Account creation (→ pending after submit)
│   ├── pending.ejs         ← NEW: Awaiting activation page
│   ├── expired.ejs         ← NEW: Subscription expired page
│   ├── dashboard.ejs       ← UPGRADED: Full POS management UI
│   └── admin.ejs           ← UPGRADED: Super-admin control panel
├── routes/
│   ├── auth.js             ← login · register · pending · expired · dashboard · logout
│   ├── api.js              ← /api/products · /api/sales · /api/stats · /api/check-status · /api/notifications
│   └── admin.js            ← /admin · toggle-status · extend-days · notify · whatsapp config · delete
├── middleware/
│   ├── checkSubscription.js ← CRITICAL FIX: live DB status, last_seen, exempt routes
│   └── auth.js              ← requireAuth · requireAdmin guards
├── db/
│   ├── pool.js             ← pg Pool singleton
│   └── schema_v2.sql       ← Migration: last_seen, subscription_end_date, pending/lifetime,
│                               category/sku, notifications, admin_config
├── public/                 ← Static assets
├── app.js                  ← Express server
├── package.json
└── .env.example
```

---

## Subscription Lifecycle (v2)

```
  register → [pending] ──── Admin activates ────► [trial]
                                                      │
                                       trial expires  │  Admin activates
                                              ▼       ▼
                                         [expired]  [active]
                                              │
                                    Admin restores │  Admin sets
                                              │       ▼
                                              └──► [lifetime]
```

---

## Key API Endpoints

| Method | Route | Description |
|---|---|---|
| `GET`  | `/api/check-status`                     | Poll for live subscription status (used by expired/pending pages) |
| `POST` | `/api/products`                         | Add product `{ name, price, stock, category?, sku? }` |
| `PATCH`| `/api/products/:id`                     | Edit product fields |
| `POST` | `/api/sales`                            | Record sale (atomic transaction) |
| `DELETE`| `/api/notifications/:id`               | Dismiss admin notification |
| `POST` | `/admin/stores/:id/toggle-status`       | Set store status |
| `POST` | `/admin/stores/:id/extend-days`         | Add N days to subscription |
| `POST` | `/admin/stores/:id/notify`              | Send in-app notification to store |
| `POST` | `/admin/config/whatsapp`               | Update admin WhatsApp number |
| `DELETE`| `/admin/stores/:id`                   | Permanently delete store |

---

## v3 — Employee & Cashier System

### New Files

| File | Description |
|---|---|
| `views/landing.ejs`           | Arabic RTL pricing page with 3 plans & WhatsApp CTAs |
| `views/cashier_login.ejs`     | Employee PIN login with animated numpad |
| `views/cashier_dashboard.ejs` | Employee POS — product grid, personal sales, Arabic RTL |
| `routes/cashier.js`           | `/cashier/login` · `/cashier/dashboard` · `/cashier/sales` · `/cashier/logout` |
| `routes/employees.js`         | `/api/employees` CRUD · reset PIN · toggle active · sales report |
| `db/schema_v3.sql`            | `employees` table · `sales.employee_id` FK · sales summary views |

### Cashier Login Flow

```
Employee opens  →  /cashier/login
Enters:             Store ID (owner shares this)
                    Employee Number (e.g. 1, EMP01)
                    PIN (4–6 digits, set by owner)
System checks:      PIN bcrypt match + store is active
Redirects to:       /cashier/dashboard
```

### What Cashiers CAN do
- Record sales (attributed to them via `employee_id`)
- See their own today's transactions & revenue
- Search and browse available products

### What Cashiers CANNOT do
- Access `/dashboard` (owner panel)
- See other employees' sales
- Edit/add/delete products
- See full store revenue

### Owner sees in Dashboard → Employees tab
- Full employee list with today's revenue per person
- Add cashier (name + number + PIN)
- Reset any employee's PIN
- Activate / deactivate accounts
- Delete employee (past sales preserved)
- Store ID displayed so owner can share with employees

### Pricing Plans (landing.ejs)

| Plan | Price | Key Feature |
|---|---|---|
| Basic الأساسي | 200 EGP/month | Single owner, no employees |
| Premium بريميم | 400 EGP/month | Up to 10 cashiers with PIN login |
| Enterprise الاحترافي | 2000 EGP one-time | Unlimited employees, lifetime access |

WhatsApp number: **01021761285** — pre-filled in all CTA buttons.

### Run v3 Migration
```bash
psql $DATABASE_URL -f db/schema_v3.sql
```



