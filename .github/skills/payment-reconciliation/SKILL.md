---
name: payment-reconciliation
description: 'Reconcile Eviivo Payments Received CSV files with bookings and the hotel portal payment ledger. Use for payment imports, missing or unmatched booking references, duplicate/group-booking checks, refunds, amount discrepancies, and verification of reconciliation reports.'
argument-hint: '[property or date range]'
user-invocable: true
disable-model-invocation: false
---

# Payment Reconciliation

## Purpose

Produce an auditable reconciliation of Eviivo payment exports against reservation revenue for Harbour, HH, and Orlando. Preserve the distinction between the imported Eviivo payment feed and payments entered through the portal.

## Data Model

- Raw payment exports live under `raw_data/<property>/Payments Received - <property>.csv`.
- `src/importData.js` imports bookings into `bookings` and Eviivo payment rows into `payments`.
- Payment identity in `payments` is the composite `(payment_id, booking_reference)` used by the importer upsert.
- The portal reconciliation endpoint `/api/reports/reconciliation` reads `bookings` plus `reservation_payments`, not the imported `payments` table.
- Group bookings are allocated by `order_reference` in the portal's `DISTRIBUTED_CTE`; compare group totals before judging individual room allocations.
- Amounts are GBP in the current importer. Treat negative amounts as refunds or charges and investigate them separately from positive collections.

## Procedure

1. Confirm scope and inputs.
   - Record the property, source file, reporting date basis, and reconciliation cutoff.
   - Check that the matching booking export is present beside the payment export.
   - Do not treat a file with a changed header or different currency as a normal rerun.

2. Inspect the payment export before importing.
   - Confirm the Eviivo header row and the real data rows are present.
   - Required identifiers are `PaymentID` (or `Payment ID`) and `BookingReference` (or `Booking Reference`). Rows missing either identifier are skipped by the importer.
   - Confirm the candidate amount columns: `Direct1`, `Total Paid`, `SettledAmount`, `OTAPrepaid1`, or `Amount`, in that precedence order.
   - Check whether rows are payment rows, `On Account` balance-transfer rows, refunds, or zero-value companion rows.
   - Check for duplicate payment IDs, group references, blank booking references, negative amounts, and dates outside the requested cutoff.

3. Prepare the database connection.
   - Verify the PostgreSQL variables used by `src/db.js`: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`.
   - Initialize the base tables when required:

     ```text
     npm run init
     ```

     If the repository has no `init` script, run the equivalent existing initializer directly:

     ```text
     node src/init-db.js
     ```

   - Never run an import while another import or watcher is writing the same database.

4. Import the source data idempotently.
   - Run the repository importer from the project root:

     ```text
     npm run import
     ```

   - The importer scans all CSVs in each of `Harbour`, `HH`, and `Orlando`, imports non-payment files as bookings first, then payment files.
   - Capture the inserted or updated counts and any skipped-row or database errors.
   - A successful command is not proof of a complete reconciliation: rows without both identifiers are intentionally skipped, and an upsert can hide a changed source row.

5. Verify import completeness in SQL.
   - Compare source row counts with database counts, excluding the two header-like rows when present and documenting the rule used.
   - Check for missing booking matches:

     ```sql
     SELECT p.payment_id, p.booking_reference, p.amount
     FROM payments p
     LEFT JOIN bookings b ON b.booking_reference = p.booking_reference
     WHERE b.booking_reference IS NULL;
     ```

   - Check duplicate source identities and payment rows with no usable amount or date:

     ```sql
     SELECT payment_id, booking_reference, COUNT(*)
     FROM payments
     GROUP BY payment_id, booking_reference
     HAVING COUNT(*) > 1;

     SELECT payment_id, booking_reference, amount, received_date_time
     FROM payments
     WHERE amount IS NULL OR received_date_time IS NULL;
     ```

   - If missing matches are found, classify them as a booking export gap, identifier mismatch, wrong property file, or source-data defect before changing importer logic.

6. Reconcile totals at the booking and property levels.
   - Aggregate imported payments by `booking_reference`, then compare with `bookings.total_revenue` and `bookings.paid_amount`.
   - Use a tolerance of GBP 0.01 for rounding, but do not silently absorb larger differences.
   - Classify each booking as fully paid, partially paid, unpaid, overpaid, refund/charge affected, or unmatched.
   - For a nonblank `order_reference`, reconcile the order total first. Do not flag a room-level mismatch until the group allocation is understood.
   - Keep refunds and negative charges visible; net and gross totals must both be reported when they differ.

7. Check the portal's separate ledger.
   - Start the API when UI or endpoint verification is needed:

     ```text
     npm run server
     ```

   - Query `/api/reports/reconciliation` with the selected property and date range. Confirm the returned `booked_amount`, `total_paid_amount`, `balance_due`, and `payment_status`.
   - Compare the result to `reservation_payments`, not directly to `payments`. If the portal and imported feed disagree, determine whether the difference is a missing manual ledger entry, an intentional adjustment, or an ETL mapping issue.
   - For group bookings, verify the portal's distributed paid amount at the order level before reviewing individual rows.

8. Resolve discrepancies by category.
   - Missing booking: obtain or re-import the corresponding booking export; do not create a fake booking solely to make a payment match.
   - Missing payment identifier: return the row to the source owner for correction or document it as an excluded source row.
   - Duplicate payment: compare payment ID, booking reference, order reference, date, and amount before deciding whether it is a true duplicate or a group-booking companion row.
   - Amount mismatch: verify the selected source amount column, currency, refund sign, and whether the row is a total or a component.
   - Portal-only payment: verify `reservation_payments` history and the manual-entry reason before changing imported data.
   - Imported-only payment: confirm whether the portal is expected to display Eviivo feed payments; if it is, treat the separation as an integration gap rather than manually duplicating rows.
   - Date mismatch: state whether the report uses received date, booked date, check-in date, or another cutoff.

9. Re-run and document the result.
   - Re-run the same checks after any correction; imports are designed to be safe to rerun for the same composite identity.
   - Record source files, cutoff, imported counts, matched and unmatched counts, gross payments, refunds, net payments, booked revenue, outstanding balance, tolerance, and unresolved exceptions.
   - Do not report success until database integrity, source totals, booking matches, group totals, and portal totals have all been checked.

## Completion Criteria

- All in-scope source files and cutoff rules are recorded.
- Import completes without an unreviewed error.
- Every payment row is matched, intentionally excluded, or listed as an exception.
- Duplicate identities, missing references, refunds, and group bookings are reviewed.
- Gross, refund, and net payment totals reconcile within the stated tolerance.
- Portal reconciliation results are checked separately against `reservation_payments`.
- Remaining discrepancies have an owner, reason, and next action.

## Safety Rules

- Do not delete source rows or database rows to force totals to balance.
- Do not treat a zero amount as proof that no payment exists.
- Do not compare room-level group-booking amounts without checking the order total.
- Do not claim that `npm run import` updated the portal payment history unless the imported `payments` table is explicitly wired into that portal view.
