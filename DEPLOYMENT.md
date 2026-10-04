# Supabase and Vercel deployment

## Database

The application accepts a PostgreSQL connection URI through `DATABASE_URL`,
`POSTGRES_URL`, or `POSTGRES_PRISMA_URL`, in that precedence order. For Vercel,
use the Supabase dashboard's **Transaction pooler** connection string and keep
its SSL mode enabled. A Supabase project URL
(`https://<project-ref>.supabase.co`) is an API URL, not a PostgreSQL connection
string.

For Supabase URIs using `sslmode=require`, the connection module enables the
current `node-postgres` libpq-compatible interpretation automatically. This
keeps transport encryption enabled but does not validate the certificate
chain. Use `sslmode=verify-full` with a trusted CA when certificate validation
is required.

For local development, the existing `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
and `DB_PASSWORD` settings remain supported. A connection URI in `.env` takes
precedence over those discrete settings. Apply the additive SQL migrations with
`npm run migrate`. Do not use `supabase db reset` against the hosted project;
it is destructive.

To apply tracked migrations to the linked Supabase project:

```text
npx supabase db push --linked
```

The CLI may prompt for the database password. The migration creates or adds the
application's tables, columns, indexes, and the `receipts` Storage bucket. It
also copies existing Prisma `public."Booking"` and `public."Payment"` rows into
the lowercase application tables when those source tables exist. The original
Prisma tables remain unchanged. Booking references, order references, payment
references, amounts, dates, property, room, guest, payment method, and legacy
metadata are retained; currency is set to GBP to match the current importer.
The migration does not copy records from local PostgreSQL.
Payment identity uniqueness is enforced on `(payment_id, booking_reference)`;
existing duplicate identities must be reconciled before that unique index can
be created.

## One-time local data transfer

The local PostgreSQL dataset is transferred separately from the schema push.
With the local `DB_*` settings still available in `.env` and
`DATABASE_URL` temporarily set to the Supabase pooler URI, inspect the merge
first:

```text
npm run migrate:data -- --dry-run
```

The dry run reports counts and identity/amount conflicts without writing rows.
Apply the transfer only after reviewing that report:

```text
npm run migrate:data -- --apply
```

Existing remote rows are preserved on identity conflicts by default. If the
local database is confirmed as the source of truth for payment conflicts, pass
`--overwrite-payment-conflicts` with `--apply`; matching payments are then
updated from local values. Dynamic text columns from booking and payment
imports are added to Supabase before copying. The transfer is rerunnable and
does not delete source or destination rows; local data is authoritative only
for the explicitly requested payment overwrite option. Integer sequences are
advanced to match copied rows.

## Vercel environment variables

Configure these for the Production environment, and for Preview/Development
only when those deployments should use Supabase:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Supabase PostgreSQL transaction-pooler URI from the dashboard's Connect panel, with SSL required. Use one of `DATABASE_URL`, `POSTGRES_URL`, or `POSTGRES_PRISMA_URL`. |
| `SUPABASE_URL` | Yes | Project API URL, for example `https://lbqbvfplgjyvxahvibjb.supabase.co`; used by receipt storage. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only Supabase key used to upload and delete receipt objects. Never expose it to browser code. |
| `SUPABASE_STORAGE_BUCKET` | Optional | Overrides the receipt bucket name; defaults to `receipts`. |
| `PGSSLMODE` | Optional | SSL setting when the connection URI does not include `sslmode`; use `require` for Supabase. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Yes for Google Sheets features | Complete Google service-account JSON value. Share the account with the required spreadsheets. |
| `GOOGLE_SHEETS_IN_OUT_ID` | Yes for In & Out sync | Spreadsheet ID for the In and Out task. |
| `GOOGLE_SHEETS_CASH_ID` | Yes for Cash sync | Spreadsheet ID for the Cash task. |
| `GOOGLE_SHEETS_CARD_ID` | Yes for Card sync | Spreadsheet ID for the Card task. |
| `OPENAI_API_KEY` | Optional | Enables AI report generation. |
| `OPENAI_API_URL` | Optional | Overrides the OpenAI-compatible chat-completions URL. |
| `OPENAI_MODEL` | Optional | Overrides the AI report model. |
| `ZOHO_CLIQ_WEBHOOK` | Optional | Default daily-handover webhook. |
| `ZOHO_CLIQ_WEBHOOK_<PROPERTY>` | Optional | Property-specific Zoho Cliq webhook; normalize the property name as the server does. |

`GOOGLE_APPLICATION_CREDENTIALS` is a filesystem path and is intended for local
development. Use `GOOGLE_SERVICE_ACCOUNT_JSON` in Vercel. Vercel supplies
`PORT`; do not set it manually. Do not configure the local `DB_*` variables when
`DATABASE_URL` is used.

## Deploy

Vercel serves the static application from `public/` and exposes the Express API
through `api/index.js`. No frontend build command is needed. The package's
`start` script is provided for conventional Node hosting and local production
checks. Run the migration before deploying code that depends on its tables.

Receipt images are stored in the public Supabase Storage bucket named
`receipts`, created by the migration if it does not already exist. This
preserves the application's current publicly accessible receipt-link behavior.
