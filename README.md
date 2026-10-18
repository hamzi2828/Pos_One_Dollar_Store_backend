# Pos_One_Dollar_Store_backend — DOLLAR & Co POS API

Admin panel API for the DOLLAR & Co dollar store (one shop, prices in PKR, Asia/Karachi).
Express 5 + Mongoose 8. Architecture of the store-operations modules: `docs/STORE_OPERATIONS.md`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `MONGO_URI`, `JWT_SECRET`, `FRONTEND_ORIGIN`.
3. Super admin login: `ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" npm run seed:admin`
   (add `ADMIN_PASSWORD=...`, or a strong password is generated and printed once).
4. Shop setup: `npm run seed:dollar-store` — settings, the shop, roles (Manager, Cashier,
   Warehouse Assistant, Purchaser), categories, price tiers, racks A1–D20, Counter 1 and
   expense categories. Safe to re-run: it prints what it created and what it skipped.
5. `npm run dev` (or `npm start`).

Staff logins are created on the Staff page (`/admin/staff`) or for an employee
(`POST /api/employees/:id/login`), with a role from the Roles page.
