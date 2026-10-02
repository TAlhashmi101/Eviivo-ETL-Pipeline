// ============================================================================
// [SECTION-01]: DEPENDENCIES, APP CONFIG & SCHEMA
// ============================================================================
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('./db');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const GOOGLE_SHEETS_READONLY_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const ROOT_GOOGLE_CREDENTIALS = path.resolve(__dirname, '..', './credentials.json');
const googleSheetsClients = new Map();
const receiptUploadDir = path.join(__dirname, '..', 'public', 'uploads', 'receipts');
fs.mkdirSync(receiptUploadDir, { recursive: true });
const receiptStorage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, receiptUploadDir),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`);
  }
});
const receiptUpload = multer({
  storage: receiptStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});

function loadGoogleServiceAccount(keyFile) {
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read Google credentials from ${keyFile}: ${error.message}`);
  }

  const clientEmail = String(credentials.client_email || '').trim();
  const privateKey = String(credentials.private_key || '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (credentials.type !== 'service_account' || !clientEmail || !privateKey) {
    throw new Error(`Invalid service-account credentials in ${keyFile}: type, client_email, and private_key are required.`);
  }
  if (!privateKey.startsWith('-----BEGIN PRIVATE KEY-----') || !privateKey.endsWith('-----END PRIVATE KEY-----')) {
    throw new Error(`Invalid private_key format in ${keyFile}: expected a complete PRIVATE KEY PEM block.`);
  }
  if (privateKey.includes('\\n')) {
    throw new Error(`Invalid private_key format in ${keyFile}: escaped newlines were not normalized.`);
  }

  return { client_email: clientEmail, private_key: privateKey };
}

async function getGoogleSheetsClient(scopes = GOOGLE_SHEETS_SCOPES) {
  const scopeKey = scopes.join(' ');
  if (googleSheetsClients.has(scopeKey)) return googleSheetsClients.get(scopeKey);

  const configuredPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  const candidatePaths = [
    configuredPath,
    ROOT_GOOGLE_CREDENTIALS,
    path.resolve(__dirname, '..', 'google-credentials.json.json')
  ].filter(Boolean);
  const keyFile = candidatePaths.find(candidate => fs.existsSync(candidate));
  if (!keyFile) {
    const configuredHint = configuredPath ? `Configured path does not exist: ${configuredPath}` : 'GOOGLE_APPLICATION_CREDENTIALS is not set';
    throw new Error(`Missing credentials.json file or GOOGLE_APPLICATION_CREDENTIALS env variable. ${configuredHint}`);
  }

  const clientPromise = (async () => {
    try {
      const credentials = loadGoogleServiceAccount(keyFile);
      const auth = new google.auth.GoogleAuth({ credentials, scopes });
      await auth.getClient();
      return google.sheets({ version: 'v4', auth });
    } catch (error) {
      throw new Error(`Google Sheets authentication failed using ${keyFile}: ${error.message}`);
    }
  })();
  googleSheetsClients.set(scopeKey, clientPromise);
  try {
    return await clientPromise;
  } catch (error) {
    googleSheetsClients.delete(scopeKey);
    throw error;
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservation_payments (
        payment_id SERIAL PRIMARY KEY,
        booking_reference VARCHAR(100) NOT NULL,
        order_reference VARCHAR(100),
        amount NUMERIC(10, 2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        card_brand VARCHAR(50),
        card_last_four VARCHAR(4),
        description TEXT,
        payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_name VARCHAR(255) NOT NULL DEFAULT 'Portal User',
        last_updated_date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_payments_booking_ref ON reservation_payments(booking_reference);

      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS company_name VARCHAR(255);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS company_vat VARCHAR(100);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS property_name VARCHAR(255);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS unique_payment_key VARCHAR(255);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'GBP';
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(100);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_date TIMESTAMP;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_name VARCHAR(255) NOT NULL DEFAULT 'Eviivo Import';
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_updated_date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE reservation_payments ADD COLUMN IF NOT EXISTS user_name VARCHAR(255) NOT NULL DEFAULT 'Portal User';
      ALTER TABLE reservation_payments ADD COLUMN IF NOT EXISTS last_updated_date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
      UPDATE payments
      SET user_name = COALESCE(NULLIF(raw_data->>'UserName', ''), NULLIF(raw_data->>'User', ''), user_name),
          last_updated_date_time = COALESCE(
            CASE WHEN raw_data->>'LastUpdatedDateTime' ~ '^\\d{1,2}-[A-Za-z]{3}-\\d{2,4} \\d{1,2}:\\d{2}'
              THEN to_timestamp(raw_data->>'LastUpdatedDateTime', 'DD-Mon-YY HH24:MI:SS.MS')::timestamp
            END,
            last_updated_date_time
          )
      WHERE raw_data ?| ARRAY['UserName', 'User', 'LastUpdatedDateTime'];
      DO $$
      DECLARE constraint_record RECORD;
      BEGIN
        FOR constraint_record IN
          SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
          WHERE t.relname = 'payments'
            AND c.contype IN ('u', 'p')
          GROUP BY c.conname
          HAVING COUNT(*) = 1 AND BOOL_AND(a.attname = 'payment_id')
        LOOP
          EXECUTE format('ALTER TABLE payments DROP CONSTRAINT IF EXISTS %I', constraint_record.conname);
        END LOOP;
      END $$;
      DROP INDEX IF EXISTS payments_payment_id_key;
      DROP INDEX IF EXISTS payments_payment_id_unique;
      DROP INDEX IF EXISTS payments_identity_idx;
      ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_identity;
      CREATE UNIQUE INDEX IF NOT EXISTS payments_unique_payment_key_idx ON payments(unique_payment_key);
      UPDATE payments SET payment_date = received_date_time WHERE payment_date IS NULL AND received_date_time IS NOT NULL;
      UPDATE payments SET received_date_time = payment_date WHERE received_date_time IS NULL AND payment_date IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_mapping_presets (
        preset_id SERIAL PRIMARY KEY,
        task_type VARCHAR(30) NOT NULL,
        preset_name VARCHAR(120) NOT NULL,
        mapping JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (task_type, preset_name)
      );
      DELETE FROM bookings
      WHERE LOWER(TRIM(COALESCE(booking_status, ''))) IN ('canceled', 'cancelled')
        AND COALESCE(total_revenue, 0) = 0
        AND COALESCE(paid_amount, 0) = 0;
      CREATE INDEX IF NOT EXISTS idx_bookings_check_in ON bookings(check_in);
      CREATE INDEX IF NOT EXISTS idx_bookings_check_out ON bookings(check_out);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address_line TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS city VARCHAR(120);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS postcode VARCHAR(30);
      CREATE TABLE IF NOT EXISTS reservation_charges (
        charge_id SERIAL PRIMARY KEY,
        booking_reference VARCHAR(100) NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'Ad Hoc',
        description TEXT NOT NULL,
        amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
        charge_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_charges_booking_ref ON reservation_charges(booking_reference);
      CREATE TABLE IF NOT EXISTS booking_cards (
        card_id SERIAL PRIMARY KEY,
        booking_reference VARCHAR(100) NOT NULL,
        cardholder_name VARCHAR(255) NOT NULL,
        card_brand VARCHAR(50),
        last_four VARCHAR(4),
        expiry_month VARCHAR(2),
        expiry_year VARCHAR(4),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS booking_messages (
        message_id SERIAL PRIMARY KEY,
        booking_reference VARCHAR(100) NOT NULL,
        message_type VARCHAR(40) NOT NULL DEFAULT 'Internal Note',
        message_text TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_cards_ref ON booking_cards(booking_reference);
      CREATE INDEX IF NOT EXISTS idx_booking_messages_ref ON booking_messages(booking_reference);
      CREATE TABLE IF NOT EXISTS petty_expenses (
        id SERIAL PRIMARY KEY,
        property_name VARCHAR(255) NOT NULL,
        manager_name VARCHAR(255) NOT NULL,
        expense_date DATE NOT NULL,
        description TEXT NOT NULL,
        amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
        receipt_image_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_petty_expenses_property_date ON petty_expenses(property_name, expense_date);
      ALTER TABLE petty_expenses ALTER COLUMN amount TYPE NUMERIC(10, 2) USING ROUND(amount::numeric, 2);
      CREATE TABLE IF NOT EXISTS monthly_settlements (
        id SERIAL PRIMARY KEY,
        property_name VARCHAR(255) NOT NULL,
        manager_name VARCHAR(255) NOT NULL,
        settlement_month VARCHAR(7) NOT NULL CHECK (settlement_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        expected_cash NUMERIC(12, 2) NOT NULL DEFAULT 0,
        total_expenses NUMERIC(12, 2) NOT NULL DEFAULT 0,
        actual_cash_in_hand NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (actual_cash_in_hand >= 0),
        variance NUMERIC(12, 2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL CHECK (status IN ('Balanced', 'Shortage', 'Overage')),
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        locked_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (property_name, settlement_month)
      );
      CREATE INDEX IF NOT EXISTS idx_monthly_settlements_month ON monthly_settlements(settlement_month, property_name);
    `);
    console.log('✅ DB Schema Synchronized (Payments, Corporate & Notes).');
  } catch (err) {
    console.error('⚠️ DB Migration notice:', err.message);
  }
})();

// ============================================================================
// [CORE-LOGIC]: GROUP PAYMENTS DISTRIBUTION ENGINE
// ============================================================================
const DISTRIBUTED_CTE = `
  WITH group_aggregates AS (
    SELECT order_reference,
           SUM(COALESCE(total_revenue::numeric, 0)) AS group_total_booked,
           SUM(COALESCE(paid_amount::numeric, 0)) AS group_total_paid,
           COUNT(*) AS group_total_rooms
    FROM bookings
    WHERE order_reference IS NOT NULL AND TRIM(order_reference) != ''
      AND NOT (LOWER(TRIM(COALESCE(booking_status, ''))) IN ('canceled', 'cancelled')
        AND COALESCE(total_revenue, 0) = 0 AND COALESCE(paid_amount, 0) = 0)
    GROUP BY order_reference
  ),
  distributed_bookings AS (
    SELECT b.*,
           COALESCE(ga.group_total_rooms, 1) AS group_total_rooms,
           CASE 
             WHEN COALESCE(ga.group_total_rooms, 1) > 1 AND COALESCE(ga.group_total_booked, COALESCE(b.total_revenue::numeric, 0)) > 0 THEN 
               ROUND((COALESCE(b.total_revenue::numeric, 0) * (COALESCE(ga.group_total_paid, COALESCE(b.paid_amount::numeric, 0)) / ga.group_total_booked))::numeric, 2)
             ELSE COALESCE(b.paid_amount::numeric, 0)
           END AS distributed_paid_amount
    FROM bookings b
    LEFT JOIN group_aggregates ga ON b.order_reference = ga.order_reference
    WHERE NOT (LOWER(TRIM(COALESCE(b.booking_status, ''))) IN ('canceled', 'cancelled')
      AND COALESCE(b.total_revenue, 0) = 0 AND COALESCE(b.paid_amount, 0) = 0)
  )
`;

const RECORDED_PAID_SQL = `(
  SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.booking_reference = b.booking_reference AND p.is_deleted = FALSE
) + (
  SELECT COALESCE(SUM(rp.amount), 0) FROM reservation_payments rp
  WHERE rp.booking_reference = b.booking_reference
    AND rp.payment_method NOT IN ('Waive/Discount', 'Deposit Waive/Discount')
)`;
// Core booking totals exclude other_revenue, which is reserved for independent
// damage-deposit metadata and must never inflate room revenue or balance due.
const NET_TOTAL_SQL = `COALESCE(b.total_revenue::numeric, 0)`;
const APPLIED_PAID_SQL = `LEAST((${RECORDED_PAID_SQL}), (${NET_TOTAL_SQL}))`;
const NET_BALANCE_SQL = `(${NET_TOTAL_SQL}) - (${APPLIED_PAID_SQL})`;
function netBalanceFor() { return NET_BALANCE_SQL; }
const PAYMENT_AMOUNT_SQL = `COALESCE(NULLIF(regexp_replace(COALESCE(p.direct1, ''), '[^0-9.-]', '', 'g'), '')::numeric, p.amount, 0)`;
const PAYMENT_DATE_SQL = 'CAST(COALESCE(p.received_date_time, p.payment_date) AS DATE)';

const sharedSelectSQL = `
  b.booking_reference, b.order_reference, b.property_name, b.company_name, b.company_vat,
  b.guest_first_name, b.guest_last_name, CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) AS guest_name, 
  b.telephone, b.email, b.room_unit_name, b.room_unit_type,
  TO_CHAR(b.check_in, 'YYYY-MM-DD') AS check_in, TO_CHAR(b.check_out, 'YYYY-MM-DD') AS check_out,
  b.nights, b.adults, b.children, b.booking_date, b.raw_data, b.other_revenue::numeric AS other_revenue, b.address_line, b.city, b.postcode, COALESCE(b.channel, 'Direct') AS channel, b.booking_status, b.total_revenue::numeric AS booked_amount,
  ROUND((${NET_TOTAL_SQL})::numeric, 2) AS net_total,
  b.distributed_paid_amount::numeric AS total_paid_amount, 
  ROUND((b.total_revenue::numeric - b.distributed_paid_amount)::numeric, 2) AS balance_due,
  COALESCE(NULLIF(b.notes, ''), b.booking_notes, '') AS notes, 
  (SELECT COALESCE(json_agg(payment ORDER BY payment_date DESC NULLS LAST, ledger_id DESC), '[]'::json)
   FROM (
    SELECT CONCAT('manual-', p.payment_id) AS ledger_id, p.payment_id, NULL::text AS unique_payment_key, p.payment_date,
            p.amount, COALESCE(NULLIF(p.payment_method, ''), 'Manual Entry') AS payment_method,
            COALESCE(NULLIF(p.description, ''), 'Manual ledger entry') AS description,
            p.user_name, p.last_updated_date_time, FALSE AS is_deleted, 'manual' AS source, NULL::integer AS imported_id
     FROM reservation_payments p
    WHERE p.booking_reference = b.booking_reference
     UNION ALL
         SELECT CONCAT('imported-', p.payment_id, '-', p.booking_reference) AS ledger_id, NULL::integer AS payment_id,
           p.unique_payment_key,
            COALESCE(p.payment_date, p.received_date_time) AS payment_date, p.amount,
            COALESCE(NULLIF(p.payment_method, ''), NULLIF(p.payment_type, ''), 'Imported payment') AS payment_method,
                 COALESCE(NULLIF(p.raw_data->>'Description', ''), NULLIF(p.raw_data->>'Payment Description', ''), NULLIF(p.payment_type, ''), NULLIF(p.payment_status, ''), 'Payments Received import') AS description,
                 p.user_name, p.last_updated_date_time, p.is_deleted, 'imported' AS source, p.id AS imported_id
     FROM payments p
               WHERE p.booking_reference = b.booking_reference AND p.is_deleted = FALSE
   ) payment) AS payment_history,
  (SELECT COALESCE(SUM(amount), 0) FROM reservation_payments p WHERE p.booking_reference = b.booking_reference AND amount < 0 AND p.payment_method NOT IN ('Waive/Discount', 'Deposit Waive/Discount')) + (SELECT COALESCE(SUM(amount), 0) FROM reservation_charges c WHERE c.booking_reference = b.booking_reference) AS total_charges,
  (SELECT COALESCE(SUM(amount), 0) FROM reservation_payments p WHERE p.booking_reference = b.booking_reference AND p.payment_method = 'Waive/Discount') AS total_waivers,
  (SELECT COALESCE(SUM(amount), 0) FROM reservation_payments p WHERE p.booking_reference = b.booking_reference AND p.payment_method = 'Deposit Waive/Discount') AS total_deposit_waivers,
  GREATEST(COALESCE(b.other_revenue::numeric, 0) - ABS((SELECT COALESCE(SUM(amount), 0) FROM reservation_payments p WHERE p.booking_reference = b.booking_reference AND p.payment_method = 'Deposit Waive/Discount')), 0) AS deposit_balance,
  ABS((SELECT COALESCE(SUM(amount), 0) FROM reservation_payments p WHERE p.booking_reference = b.booking_reference AND p.payment_method = 'Deposit Waive/Discount')) AS deposit_waived,
  (SELECT COALESCE(json_agg(c ORDER BY c.charge_date DESC), '[]'::json) FROM reservation_charges c WHERE c.booking_reference = b.booking_reference) AS charge_history,
  (SELECT COALESCE(json_agg(card ORDER BY created_at DESC), '[]'::json) FROM booking_cards card WHERE card.booking_reference = b.booking_reference) AS card_history,
  (SELECT COALESCE(json_agg(message ORDER BY created_at DESC), '[]'::json) FROM booking_messages message WHERE message.booking_reference = b.booking_reference) AS message_history
`;

const bookingDetailSelectSQL = sharedSelectSQL
  .replace('b.distributed_paid_amount::numeric AS total_paid_amount,', `
    ${APPLIED_PAID_SQL} AS total_paid_amount,`)
  .replace('ROUND((b.total_revenue::numeric - b.distributed_paid_amount)::numeric, 2) AS balance_due,', `
    ROUND((b.total_revenue::numeric - (
      (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.booking_reference = b.booking_reference AND p.is_deleted = FALSE)
      + (SELECT COALESCE(SUM(rp.amount), 0) FROM reservation_payments rp WHERE rp.booking_reference = b.booking_reference AND rp.payment_method NOT IN ('Waive/Discount', 'Deposit Waive/Discount'))
    ))::numeric, 2) AS balance_due,`);

function bookingGroupKey(booking) {
  return String(booking.raw_data?.Group ?? booking.raw_data?.group ?? '').trim()
    || String(booking.order_reference || '').trim();
}

async function applyGroupPaymentWaterfall(bookings) {
  const groupKeys = [...new Set(bookings.map(bookingGroupKey).filter(Boolean))];
    if (!groupKeys.length) return { rows: bookings, groups: new Map(), allocatedByReference: new Map() };

  const groupResult = await pool.query(`
    ${DISTRIBUTED_CTE}
    SELECT b.booking_reference, b.order_reference, b.guest_first_name, b.guest_last_name,
           CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) AS guest_name,
           b.adults, b.children, b.room_unit_name, b.property_name, b.raw_data,
           b.total_revenue::numeric AS booked_amount,
           (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.booking_reference = b.booking_reference AND p.is_deleted = FALSE)
             + (SELECT COALESCE(SUM(rp.amount), 0) FROM reservation_payments rp WHERE rp.booking_reference = b.booking_reference AND rp.payment_method NOT IN ('Waive/Discount', 'Deposit Waive/Discount')) AS recorded_paid_amount
    FROM distributed_bookings b
    WHERE COALESCE(NULLIF(TRIM(b.raw_data->>'Group'), ''), NULLIF(TRIM(b.order_reference), '')) = ANY($1::text[])
    ORDER BY COALESCE(NULLIF(TRIM(b.raw_data->>'Group'), ''), NULLIF(TRIM(b.order_reference), '')), b.booking_reference;
  `, [groupKeys]);

  const groups = new Map();
  groupResult.rows.forEach(member => {
    const key = bookingGroupKey(member);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(member);
  });

  const allocatedByReference = new Map();
  groups.forEach(members => {
    let remainingPaid = members.reduce((total, member) => total + Number(member.recorded_paid_amount || 0), 0);
    members.forEach(member => {
      const revenue = Math.max(0, Number(member.booked_amount || 0));
      const allocatedPaid = Math.min(Math.max(0, remainingPaid), revenue);
      allocatedByReference.set(member.booking_reference, allocatedPaid);
      remainingPaid -= allocatedPaid;
    });
  });

  const rows = bookings.map(booking => {
    const allocatedPaid = allocatedByReference.get(booking.booking_reference);
    if (allocatedPaid === undefined) return booking;
    return {
      ...booking,
      total_paid_amount: allocatedPaid,
      balance_due: Number(booking.booked_amount || booking.total_revenue || 0) - allocatedPaid
    };
  });
  return { rows, groups, allocatedByReference };
}

function groupMembersWithAllocation(members, allocatedByReference) {
  return members.map(member => {
    const allocatedPaid = allocatedByReference.get(member.booking_reference) || 0;
    return {
      ...member,
      total_paid_amount: allocatedPaid,
      balance_due: Number(member.booked_amount || 0) - allocatedPaid
    };
  });
}

async function recalculateBookingPaidAmount(client, bookingReference) {
  await client.query(`
    UPDATE bookings b
    SET paid_amount = COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.booking_reference = b.booking_reference AND p.is_deleted = FALSE), 0)
      + COALESCE((SELECT SUM(rp.amount) FROM reservation_payments rp WHERE rp.booking_reference = b.booking_reference), 0)
    WHERE b.booking_reference = $1;
  `, [bookingReference]);
}

// ============================================================================
// [SECTION-02]: HEALTH, PROPERTIES & DATE
// ============================================================================
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/payments', async (req, res) => {
  try {
    const bookingReference = String(req.query.booking_reference || '').trim();
    const params = [];
    const filter = bookingReference ? `AND p.booking_reference = $${params.push(bookingReference)}` : '';
    const result = await pool.query(`
      SELECT p.id, p.payment_id, p.unique_payment_key, p.booking_reference, p.property_name,
             p.amount, p.payment_method, p.payment_status, p.payment_date,
             p.user_name, p.last_updated_date_time
      FROM payments p
      WHERE p.is_deleted = FALSE ${filter}
      ORDER BY COALESCE(p.payment_date, p.received_date_time) DESC NULLS LAST, p.id DESC;
    `, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT MIN(TRIM(property_name)) AS property_name
      FROM (
        SELECT property_name FROM bookings
        WHERE property_name IS NOT NULL AND TRIM(property_name) <> ''
        UNION ALL
        SELECT property_name FROM payments
        WHERE is_deleted = FALSE AND property_name IS NOT NULL AND TRIM(property_name) <> ''
      ) property_values
      GROUP BY LOWER(TRIM(property_name))
      ORDER BY LOWER(TRIM(property_name));
    `);
    res.json(result.rows.map(row => row.property_name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/properties/rooms', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    if (!property || property.toUpperCase() === 'ALL') return res.json([]);
    const result = await pool.query(`SELECT MIN(TRIM(room_unit_name)) AS room_unit_name FROM bookings WHERE property_name IS NOT NULL AND LOWER(TRIM(property_name)) = LOWER(TRIM($1)) AND room_unit_name IS NOT NULL AND TRIM(room_unit_name) <> '' GROUP BY LOWER(TRIM(room_unit_name)) ORDER BY LOWER(TRIM(room_unit_name));`, [property]);
    res.json(result.rows.map(row => row.room_unit_name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function validSettlementMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || '').trim());
}

function validCalendarDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function settlementStatus(variance) {
  if (variance < 0) return 'Shortage';
  if (variance > 0) return 'Overage';
  return 'Balanced';
}

app.post('/api/expenses', receiptUpload.single('receipt'), async (req, res) => {
  try {
    const propertyName = String(req.body.property_name || '').trim();
    const managerName = String(req.body.manager_name || '').trim();
    const expenseDate = String(req.body.expense_date || '').trim();
    const description = String(req.body.description || '').trim();
    const amount = Math.round((Number(req.body.amount) + Number.EPSILON) * 100) / 100;
    if (!propertyName || propertyName === 'ALL' || !managerName || !validCalendarDate(expenseDate) || !description || !Number.isFinite(amount) || amount <= 0) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Property, manager, valid date, description, and a positive amount are required.' });
    }
    const month = expenseDate.slice(0, 7);
    const locked = await pool.query('SELECT 1 FROM monthly_settlements WHERE LOWER(property_name) = LOWER($1) AND settlement_month = $2 AND is_locked = TRUE', [propertyName, month]);
    if (locked.rowCount) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(409).json({ error: 'This month is already locked for the selected property.' });
    }
    const receiptImageUrl = req.file ? `/uploads/receipts/${req.file.filename}` : null;
    const result = await pool.query(`
      INSERT INTO petty_expenses (property_name, manager_name, expense_date, description, amount, receipt_image_url)
      VALUES ($1, $2, $3::DATE, $4, $5::NUMERIC(10, 2), $6)
      RETURNING id, property_name, manager_name, TO_CHAR(expense_date, 'YYYY-MM-DD') AS expense_date, description, amount, receipt_image_url, created_at;
    `, [propertyName, managerName, expenseDate, description, amount.toFixed(2), receiptImageUrl]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/expenses/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const managerName = String(req.body.manager_name || '').trim();
    const expenseDate = String(req.body.expense_date || '').trim();
    const description = String(req.body.description || '').trim();
    const amount = Math.round((Number(req.body.amount) + Number.EPSILON) * 100) / 100;
    if (!Number.isInteger(id) || id <= 0 || !managerName || !validCalendarDate(expenseDate) || !description || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'A valid expense ID, manager, date, description, and positive amount are required.' });
    const month = expenseDate.slice(0, 7);
    const existing = await pool.query("SELECT property_name, TO_CHAR(expense_date, 'YYYY-MM') AS expense_month FROM petty_expenses WHERE id = $1", [id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Expense not found.' });
    const locked = await pool.query('SELECT 1 FROM monthly_settlements WHERE LOWER(property_name) = LOWER($1) AND settlement_month IN ($2, $3) AND is_locked = TRUE', [existing.rows[0].property_name, existing.rows[0].expense_month, month]);
    if (locked.rowCount) return res.status(409).json({ error: 'This month is already locked for the selected property.' });
    const result = await pool.query(`
      UPDATE petty_expenses
      SET manager_name = $1, expense_date = $2::DATE, description = $3, amount = $4::NUMERIC(10, 2)
      WHERE id = $5
      RETURNING id, property_name, manager_name, TO_CHAR(expense_date, 'YYYY-MM-DD') AS expense_date, description, amount, receipt_image_url, created_at;
    `, [managerName, expenseDate, description, amount.toFixed(2), id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'A valid expense ID is required.' });
    const existing = await pool.query('SELECT e.property_name, TO_CHAR(e.expense_date, \'YYYY-MM\') AS expense_month, e.receipt_image_url FROM petty_expenses e WHERE e.id = $1', [id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Expense not found.' });
    const expense = existing.rows[0];
    const locked = await pool.query('SELECT 1 FROM monthly_settlements WHERE LOWER(property_name) = LOWER($1) AND settlement_month = $2 AND is_locked = TRUE', [expense.property_name, expense.expense_month]);
    if (locked.rowCount) return res.status(409).json({ error: 'This month is already locked for the selected property.' });
    await pool.query('DELETE FROM petty_expenses WHERE id = $1', [id]);
    if (expense.receipt_image_url && expense.receipt_image_url.startsWith('/uploads/receipts/')) {
      const receiptPath = path.join(__dirname, '..', 'public', expense.receipt_image_url.replace(/^\//, '').replaceAll('/', path.sep));
      if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);
    }
    res.json({ success: true, id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/reconciliation-summary', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    const month = String(req.query.month || '').trim();
    if (!property || !validSettlementMonth(month)) return res.status(400).json({ error: 'Property and month must be provided.' });
    const params = [month];
    const propertyFilter = property !== 'ALL' ? "AND LOWER(TRIM(COALESCE(NULLIF(p.business_name, ''), p.property_name))) = LOWER(TRIM($2))" : '';
    if (property !== 'ALL') params.push(property);
    const expenseFilter = property !== 'ALL' ? 'AND LOWER(TRIM(e.property_name)) = LOWER(TRIM($2))' : '';
    const [cashResult, expenseResult, expensesResult, settlementResult] = await Promise.all([
      pool.query(`SELECT ROUND(COALESCE(SUM(${PAYMENT_AMOUNT_SQL}), 0)::numeric, 2) AS expected_cash
        FROM payments p
        WHERE p.is_deleted = FALSE AND LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%cash%'
          AND TO_CHAR(CAST(COALESCE(p.received_date_time, p.payment_date) AS DATE), 'YYYY-MM') = $1
          ${propertyFilter};`, params),
      pool.query(`SELECT ROUND(COALESCE(SUM(e.amount), 0)::numeric, 2) AS total_expenses
        FROM petty_expenses e
        WHERE TO_CHAR(e.expense_date, 'YYYY-MM') = $1 ${expenseFilter};`, params),
      pool.query(`SELECT id, property_name, manager_name, TO_CHAR(expense_date, 'YYYY-MM-DD') AS expense_date, description, amount, receipt_image_url
        FROM petty_expenses e WHERE TO_CHAR(e.expense_date, 'YYYY-MM') = $1 ${expenseFilter}
        ORDER BY e.expense_date DESC, e.id DESC;`, params),
      pool.query(`SELECT id, manager_name, actual_cash_in_hand, variance, status, is_locked, locked_at
        FROM monthly_settlements WHERE settlement_month = $1 ${property !== 'ALL' ? 'AND LOWER(property_name) = LOWER($2)' : ''}
        ORDER BY property_name;`, params)
    ]);
    const expectedCash = Number(Number(cashResult.rows[0].expected_cash || 0).toFixed(2));
    const totalExpenses = Number(Number(expenseResult.rows[0].total_expenses || 0).toFixed(2));
    res.json({ property, month, expected_cash: expectedCash, total_expenses: totalExpenses, adjusted_expected: Number((expectedCash - totalExpenses).toFixed(2)), expenses: expensesResult.rows, settlements: settlementResult.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reconciliation-ledger', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    const month = String(req.query.month || '').trim();
    if (!property || !validSettlementMonth(month)) return res.status(400).json({ error: 'Property and month must be provided.' });
    const params = [month];
    const propertyFilter = property !== 'ALL' ? "AND LOWER(TRIM(COALESCE(NULLIF(p.business_name, ''), p.property_name))) = LOWER(TRIM($2))" : '';
    if (property !== 'ALL') params.push(property);
    const result = await pool.query(`
      SELECT p.unique_payment_key,
             p.received_date_time,
             p.booking_reference,
             COALESCE(NULLIF(p.room_name, ''), NULLIF(p.roomid, ''), b.room_unit_name, '-') AS room_name,
             COALESCE(NULLIF(p.guest_name, ''), NULLIF(p.forename, ''), CONCAT_WS(' ', b.guest_first_name, b.guest_last_name), '-') AS guest_name,
             ${PAYMENT_AMOUNT_SQL}::numeric AS amount,
             p.payment_method
      FROM payments p
      LEFT JOIN bookings b ON b.booking_reference = p.booking_reference
      WHERE p.is_deleted = FALSE AND LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%cash%'
        AND TO_CHAR(CAST(COALESCE(p.received_date_time, p.payment_date) AS DATE), 'YYYY-MM') = $1
        ${propertyFilter}
      ORDER BY CAST(COALESCE(p.received_date_time, p.payment_date) AS DATE), p.id;
    `, params);
    res.json({ property, month, transactions: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settlements/lock', async (req, res) => {
  const client = await pool.connect();
  try {
    const property = String(req.body.property || '').trim();
    const managerName = String(req.body.manager_name || '').trim();
    const month = String(req.body.month || '').trim();
    const actualCash = Number(req.body.actual_cash_in_hand);
    if (!property || property === 'ALL' || !managerName || !validSettlementMonth(month) || !Number.isFinite(actualCash) || actualCash < 0) return res.status(400).json({ error: 'Property, manager, month, and a non-negative actual cash amount are required.' });
    await client.query('BEGIN');
    const existing = await client.query('SELECT is_locked FROM monthly_settlements WHERE LOWER(property_name) = LOWER($1) AND settlement_month = $2 FOR UPDATE', [property, month]);
    if (existing.rows[0]?.is_locked) throw new Error('This month is already locked for the selected property.');
    const params = [month, property];
    const cashResult = await client.query(`SELECT ROUND(COALESCE(SUM(${PAYMENT_AMOUNT_SQL}), 0)::numeric, 2) AS expected_cash FROM payments p WHERE p.is_deleted = FALSE AND LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%cash%' AND TO_CHAR(CAST(COALESCE(p.received_date_time, p.payment_date) AS DATE), 'YYYY-MM') = $1 AND LOWER(TRIM(COALESCE(NULLIF(p.business_name, ''), p.property_name))) = LOWER(TRIM($2));`, params);
    const expenseResult = await client.query(`SELECT ROUND(COALESCE(SUM(amount), 0)::numeric, 2) AS total_expenses FROM petty_expenses WHERE TO_CHAR(expense_date, 'YYYY-MM') = $1 AND LOWER(TRIM(property_name)) = LOWER(TRIM($2));`, params);
    const expectedCash = Number(Number(cashResult.rows[0].expected_cash || 0).toFixed(2));
    const totalExpenses = Number(Number(expenseResult.rows[0].total_expenses || 0).toFixed(2));
    const adjustedExpected = expectedCash - totalExpenses;
    const variance = Number((actualCash - adjustedExpected).toFixed(2));
    const status = settlementStatus(variance);
    const result = await client.query(`
      INSERT INTO monthly_settlements (property_name, manager_name, settlement_month, expected_cash, total_expenses, actual_cash_in_hand, variance, status, is_locked, locked_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, CURRENT_TIMESTAMP)
      ON CONFLICT (property_name, settlement_month) DO UPDATE SET manager_name = EXCLUDED.manager_name, expected_cash = EXCLUDED.expected_cash, total_expenses = EXCLUDED.total_expenses, actual_cash_in_hand = EXCLUDED.actual_cash_in_hand, variance = EXCLUDED.variance, status = EXCLUDED.status, is_locked = TRUE, locked_at = EXCLUDED.locked_at
      RETURNING id, property_name, manager_name, settlement_month, expected_cash, total_expenses, actual_cash_in_hand, variance, status, is_locked, locked_at;
    `, [property, managerName, month, expectedCash, totalExpenses, actualCash, variance, status]);
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(409).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/api/settlements/unlock', async (req, res) => {
  try {
    const property = String(req.body.property || '').trim();
    const month = String(req.body.month || '').trim();
    if (!property || property === 'ALL' || !validSettlementMonth(month)) return res.status(400).json({ error: 'Property and month are required.' });
    const result = await pool.query(`
      UPDATE monthly_settlements
      SET is_locked = FALSE, locked_at = NULL
      WHERE LOWER(property_name) = LOWER($1) AND settlement_month = $2
      RETURNING id, property_name, manager_name, settlement_month, is_locked, locked_at;
    `, [property, month]);
    if (!result.rowCount) return res.status(404).json({ error: 'Locked settlement not found.' });
    res.json({ success: true, settlement: result.rows[0] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/schema/:tableName', async (req, res) => {
  try {
    const tableName = String(req.params.tableName || '').trim().toLowerCase();
    if (!['bookings', 'payments'].includes(tableName)) return res.status(400).json({ error: 'Only bookings and payments schemas are available.' });
    const result = await pool.query(`
      SELECT column_name, data_type, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;
    `, [tableName]);
    res.json({ table: tableName, columns: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/operations/latest-date', async (req, res) => {
  try {
    const result = await pool.query(`SELECT TO_CHAR(MAX(check_in), 'YYYY-MM-DD') as latest_date FROM bookings WHERE check_in IS NOT NULL;`);
    res.json({ latest_date: result.rows[0]?.latest_date || new Date().toISOString().split('T')[0] });
  } catch (err) { res.json({ latest_date: new Date().toISOString().split('T')[0] }); }
});

// ============================================================================
// [SECTION-03]: FULL EXECUTIVE ANALYTICS (RESTORED)
// ============================================================================
app.get('/api/kpis', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    const paymentMethod = String(req.query.payment_method || '').trim();
    const excludeCanceled = String(req.query.exclude_canceled || 'false') === 'true';
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from_date || '')) ? String(req.query.from_date) : '';
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to_date || '')) ? String(req.query.to_date) : '';
    const bookingProperty = property && property !== 'ALL' ? 'AND TRIM(b.property_name) ILIKE $1' : '';
    const paymentProperty = property && property !== 'ALL' ? 'AND TRIM(property_name) ILIKE $1' : '';
    const params = property && property !== 'ALL' ? [property] : [];
    const bookingStatus = excludeCanceled ? "AND LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')" : '';
    const dateScope = `${fromDate ? `AND b.check_in >= '${fromDate}'::DATE ` : ''}${toDate ? `AND b.check_in <= '${toDate}'::DATE ` : ''}`;
    const paymentDateScope = `${fromDate ? `AND ${PAYMENT_DATE_SQL} >= '${fromDate}'::DATE ` : ''}${toDate ? `AND ${PAYMENT_DATE_SQL} <= '${toDate}'::DATE ` : ''}`;
    const cashParams = property && property !== 'ALL' ? [property] : [];
    const cashProperty = property && property !== 'ALL' ? `AND TRIM(p.business_name) ILIKE $${cashParams.length}` : '';
    const cashMethod = paymentMethod ? `AND TRIM(p.payment_method) = $${cashParams.push(paymentMethod)}` : '';
    const [arrivals, departures, cash, methods] = await Promise.all([
      pool.query(`${DISTRIBUTED_CTE} SELECT COUNT(*)::int AS count, COALESCE(SUM(b.total_revenue::numeric - b.distributed_paid_amount), 0)::numeric AS value FROM distributed_bookings b WHERE b.check_in >= CURRENT_DATE AND b.check_in < NOW() + INTERVAL '2 days' AND (b.total_revenue::numeric - b.distributed_paid_amount) > 0 ${excludeCanceled ? "AND LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')" : ''} ${property && property !== 'ALL' ? 'AND TRIM(b.property_name) ILIKE $1' : ''} ${dateScope};`, params),
      pool.query(`${DISTRIBUTED_CTE} SELECT COUNT(*)::int AS count, COALESCE(SUM(b.total_revenue::numeric - b.distributed_paid_amount), 0)::numeric AS value FROM distributed_bookings b WHERE b.check_out < CURRENT_DATE AND (b.total_revenue::numeric - b.distributed_paid_amount) > 0 ${excludeCanceled ? "AND LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')" : ''} ${property && property !== 'ALL' ? 'AND TRIM(b.property_name) ILIKE $1' : ''} ${dateScope};`, params),
      pool.query(`SELECT COALESCE(SUM(${PAYMENT_AMOUNT_SQL}), 0)::numeric AS value
        FROM payments p
        WHERE p.is_deleted = FALSE AND ${PAYMENT_DATE_SQL} IS NOT NULL
          AND ${PAYMENT_AMOUNT_SQL} > 0
          ${paymentDateScope}
          ${cashProperty} ${cashMethod};`, cashParams),
      pool.query(`SELECT DISTINCT TRIM(p.payment_method) AS payment_method
        FROM payments p
        WHERE p.is_deleted = FALSE AND ${PAYMENT_DATE_SQL} IS NOT NULL
          AND ${PAYMENT_AMOUNT_SQL} > 0
          ${paymentDateScope.replaceAll('p.', 'p.')}
          ${property && property !== 'ALL' ? 'AND TRIM(p.business_name) ILIKE $1' : ''}
          AND NULLIF(TRIM(p.payment_method), '') IS NOT NULL
        ORDER BY 1;`, params)
    ]);
    res.json({ at_risk_arrivals: arrivals.rows[0], post_departure_debt: departures.rows[0], settled_cash: { ...cash.rows[0], payment_methods: methods.rows.map(row => row.payment_method) } });
  } catch(e) { console.error('KPI query error:', e.stack || e.message); res.status(500).json({error: e.message}); }
});

app.get('/api/reports/settled-cash', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    const excludeCanceled = String(req.query.exclude_canceled || 'false') === 'true';
    const paymentMethod = String(req.query.payment_method || '').trim();
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from_date || '')) ? String(req.query.from_date) : new Date().toISOString().slice(0, 10);
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to_date || '')) ? String(req.query.to_date) : fromDate;
    const params = [fromDate, toDate];
    const filters = [`${PAYMENT_DATE_SQL} >= $1::DATE`, `${PAYMENT_DATE_SQL} <= $2::DATE`];
    if (property && property !== 'ALL') { params.push(property); filters.push(`TRIM(p.business_name) ILIKE $${params.length}`); }
    if (paymentMethod) { params.push(paymentMethod); filters.push(`TRIM(p.payment_method) = $${params.length}`); }
    const result = await pool.query(`
            SELECT TO_CHAR(${PAYMENT_DATE_SQL}, 'YYYY-MM-DD') AS date,
              p.id, p.unique_payment_key, p.payment_id, p.business_name AS property_name, p.booking_reference,
              p.payment_method, ${PAYMENT_AMOUNT_SQL}::numeric AS amount,
              COALESCE(NULLIF(p.raw_data->>'Description', ''), NULLIF(p.raw_data->>'Payment Description', ''), NULLIF(p.payment_type, ''), p.payment_method, 'Payment') AS description
            FROM payments p
            WHERE p.is_deleted = FALSE AND ${filters.join(' AND ')}
         AND ${PAYMENT_AMOUNT_SQL} > 0
            ORDER BY ${PAYMENT_DATE_SQL} DESC, p.id DESC;
    `, params);
    const methodsResult = await pool.query(`SELECT DISTINCT TRIM(p.payment_method) AS payment_method FROM payments p WHERE p.is_deleted = FALSE AND ${filters.slice(0, 2).join(' AND ')} ${property && property !== 'ALL' ? 'AND TRIM(p.business_name) ILIKE $3' : ''} AND NULLIF(TRIM(p.payment_method), '') IS NOT NULL ORDER BY 1;`, property && property !== 'ALL' ? [fromDate, toDate, property] : [fromDate, toDate]);
    res.json({ from_date: fromDate, to_date: toDate, transactions: result.rows, total: result.rows.reduce((sum, row) => sum + Number(row.amount || 0), 0), payment_methods: methodsResult.rows.map(row => row.payment_method) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/charts', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    const grouping = ['daily', 'weekly', 'monthly'].includes(String(req.query.grouping || '').toLowerCase()) ? String(req.query.grouping).toLowerCase() : 'weekly';
    const excludeCanceled = String(req.query.exclude_canceled || 'false') === 'true';
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from_date || '')) ? String(req.query.from_date) : '';
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to_date || '')) ? String(req.query.to_date) : '';
    const params = [];
    const filters = [];
    if (!fromDate) filters.push("b.check_in >= CURRENT_DATE");
    if (excludeCanceled) filters.push("LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')");
    if (property && property !== 'ALL') { params.push(property); filters.push(`TRIM(b.property_name) ILIKE $${params.length}`); }
    if (fromDate) { params.push(fromDate); filters.push(`b.check_in >= $${params.length}::DATE`); }
    if (toDate) { params.push(toDate); filters.push(`b.check_in <= $${params.length}::DATE`); }
    const dateParams = [...params];
    const truncUnit = grouping === 'daily' ? 'day' : grouping === 'monthly' ? 'month' : 'week';
    const paceQuery = `${DISTRIBUTED_CTE} SELECT TO_CHAR(DATE_TRUNC('${truncUnit}', b.check_in::timestamp), 'YYYY-MM-DD') AS period_start, TO_CHAR(DATE_TRUNC('${truncUnit}', b.check_in::timestamp) + INTERVAL '1 ${truncUnit}' - INTERVAL '1 day', 'YYYY-MM-DD') AS period_end, COALESCE(SUM(${NET_TOTAL_SQL}), 0)::numeric AS revenue FROM distributed_bookings b WHERE ${filters.join(' AND ')} GROUP BY 1, 2 ORDER BY 1;`;
    const channelQuery = `${DISTRIBUTED_CTE} SELECT COALESCE(NULLIF(TRIM(b.channel), ''), 'Direct') AS channel_group, COUNT(*)::int AS bookings, COALESCE(SUM(${NET_TOTAL_SQL}), 0)::numeric AS revenue FROM distributed_bookings b WHERE ${filters.join(' AND ')} GROUP BY 1 ORDER BY revenue DESC;`;
    const [paceRes, channelRes] = await Promise.all([pool.query(paceQuery, dateParams), pool.query(channelQuery, dateParams)]);
    res.json({ pace: paceRes.rows, channels: channelRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/reconciliation', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const channel = String(req.query.channel || '').trim();
    const excludeCanceled = String(req.query.exclude_canceled || 'false') === 'true';
    const propertyFilter = String(req.query.property_filter || '').trim();
    const guestFilter = String(req.query.guest_filter || '').trim();
    const checkoutFilter = String(req.query.checkout_filter || '').trim();
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from_date || '')) ? String(req.query.from_date) : '';
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to_date || '')) ? String(req.query.to_date) : '';
    const params = [];
    const filters = [];
    if (property && property !== 'ALL') { params.push(property); filters.push(`TRIM(b.property_name) ILIKE $${params.length}`); }
    if (channel === 'OTA' || channel === 'Direct') { params.push(channel); filters.push(`CASE WHEN LOWER(COALESCE(b.channel, 'direct')) ~ '(booking|expedia|agoda|airbnb|hotelbeds|vrbo|travel)' THEN 'OTA' ELSE 'Direct' END = $${params.length}`); }
    if (channel && channel !== 'OTA' && channel !== 'Direct') { params.push(channel); filters.push(`COALESCE(NULLIF(TRIM(b.channel), ''), 'Direct') = $${params.length}`); }
    if (fromDate) { params.push(fromDate); filters.push(`b.check_in >= $${params.length}::DATE`); }
    if (toDate) { params.push(toDate); filters.push(`b.check_in <= $${params.length}::DATE`); }
    if (propertyFilter) { params.push(`%${propertyFilter}%`); filters.push(`b.property_name ILIKE $${params.length}`); }
    if (guestFilter) { params.push(`%${guestFilter}%`); filters.push(`CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $${params.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(checkoutFilter)) { params.push(checkoutFilter); filters.push(`b.check_out = $${params.length}::DATE`); }
    if (excludeCanceled) filters.push("LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')");
    const netBalance = `(${NET_TOTAL_SQL}) - (${APPLIED_PAID_SQL})`;
    const exceptionClause = `(b.check_out < CURRENT_DATE AND ${netBalance} > 0) OR (${netBalance} < 0) OR (b.check_in <= CURRENT_DATE AND b.check_out >= CURRENT_DATE AND ${netBalance} > 0) OR (b.check_in > CURRENT_DATE AND COALESCE(b.other_revenue::numeric, 0) - ABS(COALESCE((SELECT SUM(amount) FROM reservation_payments rp WHERE rp.booking_reference = b.booking_reference AND rp.payment_method = 'Deposit Waive/Discount'), 0)) > 0) OR (LOWER(TRIM(COALESCE(b.booking_status, ''))) IN ('canceled', 'cancelled') AND ${NET_TOTAL_SQL} > 0 AND ${RECORDED_PAID_SQL} = 0)`;
    const whereSql = `WHERE (${exceptionClause}) ${filters.length ? `AND ${filters.join(' AND ')}` : ''}`;
    const countResult = await pool.query(`${DISTRIBUTED_CTE} SELECT COUNT(*) FROM distributed_bookings b ${whereSql}`, params);
    const dataParams = [...params, limit, offset];
    const ledgerSelectSQL = sharedSelectSQL.replace('b.distributed_paid_amount::numeric AS total_paid_amount,', `${APPLIED_PAID_SQL} AS total_paid_amount,`).replace('ROUND((b.total_revenue::numeric - b.distributed_paid_amount)::numeric, 2) AS balance_due,', `ROUND(${netBalance}::numeric, 2) AS balance_due,`);
    const dataQuery = `${DISTRIBUTED_CTE} SELECT ${ledgerSelectSQL}, CASE WHEN b.check_out < CURRENT_DATE AND ${netBalance} > 0 THEN 'Post-departure debt' WHEN ${netBalance} < 0 THEN 'Refund due' WHEN b.check_in <= CURRENT_DATE AND b.check_out >= CURRENT_DATE AND ${netBalance} > 0 THEN 'In-house unpaid' WHEN b.check_in > CURRENT_DATE AND COALESCE(b.other_revenue::numeric, 0) - ABS(COALESCE((SELECT SUM(amount) FROM reservation_payments rp WHERE rp.booking_reference = b.booking_reference AND rp.payment_method = 'Deposit Waive/Discount'), 0)) > 0 THEN 'Upcoming deposit due' ELSE 'Cancellation penalty missed' END AS exception_type, ROUND(${netBalance}::numeric, 2) AS exposure FROM distributed_bookings b ${whereSql} ORDER BY CASE WHEN b.check_out < CURRENT_DATE AND ${netBalance} > 0 THEN 1 WHEN ${netBalance} < 0 THEN 2 WHEN b.check_in <= CURRENT_DATE AND b.check_out >= CURRENT_DATE THEN 3 ELSE 4 END, ABS(${netBalance}) DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length};`;
    const result = await pool.query(dataQuery, dataParams);
    res.json({ total: parseInt(countResult.rows[0].count, 10), data: result.rows });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ============================================================================
// [SECTION-03B]: AI REPORTS (ALLOWLISTED, READ-ONLY REPORT BUILDER)
// ============================================================================
const AI_REPORTS = {
  daily_sales: { title: 'Daily Sales' },
  check_ins: { title: 'Check-ins' },
  in_out: { title: 'In and Out' },
  cash: { title: 'Cash Receipts' },
  card: { title: 'Card Receipts' },
  payments: { title: 'Payment Ledger' }
};

function reportFilters(query, dateColumn = 'b.check_in') {
  const clauses = [];
  const params = [];
  const property = String(query.property || '').trim();
  const fromDate = String(query.from_date || '').trim();
  const toDate = String(query.to_date || '').trim();
  if (property && property !== 'ALL') { params.push(property); clauses.push(`LOWER(TRIM(${/\bp\./.test(dateColumn) ? 'p.property_name' : 'b.property_name'})) = LOWER(TRIM($${params.length}))`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) { params.push(fromDate); clauses.push(`${dateColumn}::DATE >= $${params.length}::DATE`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(toDate)) { params.push(toDate); clauses.push(`${dateColumn}::DATE <= $${params.length}::DATE`); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function buildAiReport(type, query) {
  const normalized = AI_REPORTS[type] ? type : 'daily_sales';
  if (normalized === 'cash' || normalized === 'card' || normalized === 'payments') {
    const method = normalized === 'cash' ? "LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%cash%'" : normalized === 'card' ? "(LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%card%' OR LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%visa%' OR LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%mastercard%')" : 'TRUE';
    const filters = reportFilters(query, 'COALESCE(p.payment_date, p.received_date_time)');
    const where = filters.sql ? `${filters.sql} AND ${method}` : `WHERE ${method}`;
    return { type: normalized, meta: AI_REPORTS[normalized], sql: `SELECT p.unique_payment_key AS "Unique Payment Key", p.payment_id AS "Payment ID", p.booking_reference AS "Booking Reference", COALESCE(p.property_name, b.property_name, 'Unknown') AS "Hotel", COALESCE(p.payment_date, p.received_date_time)::DATE AS "Payment Date", p.payment_method AS "Payment Method", p.payment_type AS "Payment Type", p.amount::NUMERIC AS "Amount", COALESCE(p.guest_name, CONCAT_WS(' ', b.guest_first_name, b.guest_last_name)) AS "Guest" FROM payments p LEFT JOIN bookings b ON b.booking_reference = p.booking_reference ${where.replace('WHERE ', 'WHERE p.is_deleted = FALSE AND ')} ORDER BY COALESCE(p.payment_date, p.received_date_time) DESC NULLS LAST, p.unique_payment_key`, params: filters.params };
  }
  if (normalized === 'daily_sales') {
    const filters = reportFilters(query, 'b.check_in');
    return { type: normalized, meta: AI_REPORTS[normalized], sql: `${DISTRIBUTED_CTE} SELECT b.check_in AS "Report Date", b.property_name AS "Hotel", COUNT(*)::INT AS "Bookings", COALESCE(SUM(b.total_revenue::NUMERIC), 0)::NUMERIC AS "Booked Revenue", COALESCE(SUM(b.distributed_paid_amount), 0)::NUMERIC AS "Collected Revenue", COALESCE(SUM(GREATEST(b.total_revenue::NUMERIC - b.distributed_paid_amount, 0)), 0)::NUMERIC AS "Outstanding" FROM distributed_bookings b ${filters.sql} GROUP BY b.check_in, b.property_name ORDER BY b.check_in DESC NULLS LAST, b.property_name`, params: filters.params };
  }
  const filters = reportFilters(query, normalized === 'in_out' ? 'b.check_in' : 'b.check_in');
  const dateClause = normalized === 'in_out' && filters.sql ? filters.sql.replace(/WHERE /, 'WHERE (b.check_in::DATE BETWEEN $1::DATE AND $2::DATE OR b.check_out::DATE BETWEEN $1::DATE AND $2::DATE) AND ') : filters.sql;
  if (normalized === 'in_out' && /^\d{4}-\d{2}-\d{2}$/.test(query.from_date) && /^\d{4}-\d{2}-\d{2}$/.test(query.to_date)) {
    const propertyParams = query.property && query.property !== 'ALL' ? [query.property] : [];
    const propertyClause = propertyParams.length ? ` AND LOWER(TRIM(b.property_name)) = LOWER(TRIM($${propertyParams.length + 2}))` : '';
    return { type: normalized, meta: AI_REPORTS[normalized], sql: `${DISTRIBUTED_CTE} SELECT b.booking_reference AS "Booking Reference", b.property_name AS "Hotel", CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) AS "Guest", b.check_in AS "Check-in Date", b.check_out AS "Check-out Date", b.room_unit_name AS "Room", b.booking_status AS "Status", b.total_revenue::NUMERIC AS "Booked Revenue" FROM distributed_bookings b WHERE (b.check_in::DATE BETWEEN $1::DATE AND $2::DATE OR b.check_out::DATE BETWEEN $1::DATE AND $2::DATE)${propertyClause} ORDER BY b.check_in DESC NULLS LAST`, params: [query.from_date, query.to_date, ...propertyParams] };
  }
  return { type: normalized, meta: AI_REPORTS[normalized], sql: `${DISTRIBUTED_CTE} SELECT b.booking_reference AS "Booking Reference", b.property_name AS "Hotel", CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) AS "Guest", b.check_in AS "Check-in Date", b.check_out AS "Check-out Date", b.room_unit_name AS "Room", b.booking_status AS "Status", b.total_revenue::NUMERIC AS "Booked Revenue", b.distributed_paid_amount::NUMERIC AS "Paid", ROUND((b.total_revenue::NUMERIC - b.distributed_paid_amount)::NUMERIC, 2) AS "Balance Due" FROM distributed_bookings b ${filters.sql} ORDER BY b.check_in DESC NULLS LAST`, params: filters.params };
}

function inferAiReport(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (text.includes('cash')) return 'cash';
  if (text.includes('card') || text.includes('visa') || text.includes('mastercard')) return 'card';
  if (text.includes('payment') || text.includes('receipt')) return 'payments';
  if (text.includes('check-in') || text.includes('check in') || text.includes('arrival')) return 'check_ins';
  if (text.includes('check-out') || text.includes('check out') || text.includes('departure') || text.includes('in and out')) return 'in_out';
  return 'daily_sales';
}

function createDatasetBrief(rows, context) {
  const numeric = key => rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
  const keys = Object.keys(rows[0] || {});
  const amountKeys = keys.filter(key => /amount|revenue|paid|outstanding|balance|total/i.test(key) && rows.some(row => Number.isFinite(Number(row[key]))));
  const warnings = [];
  if (!rows.length) warnings.push('The selected dataset returned no rows for the requested scope.');
  if (rows.some(row => Object.values(row).some(value => value === null || value === ''))) warnings.push('The selected dataset contains missing values.');
  amountKeys.forEach(key => { if (numeric(key) < 0) warnings.push(`${key} contains a negative aggregate (${numeric(key).toFixed(2)}).`); });
  const scope = [context.property && context.property !== 'ALL' ? `hotel ${context.property}` : 'all hotels', context.from_date && context.to_date ? `${context.from_date} to ${context.to_date}` : 'the selected date scope'].join(' for ');
  const totals = amountKeys.slice(0, 3).map(key => `${key}: ${numeric(key).toFixed(2)}`).join('; ');
  return { headline: `${context.title} contains ${rows.length} record${rows.length === 1 ? '' : 's'} for ${scope}.`, summary: totals || `The dataset returned ${keys.length} fields: ${keys.join(', ')}.`, warnings, auditStatus: warnings.length ? 'Dataset review recommended' : 'No anomalies detected in this dataset', scope, fields: keys };
}

async function generateFinancialBrief(rows, context) {
  const datasetBrief = createDatasetBrief(rows, context);
  if (!process.env.OPENAI_API_KEY) return datasetBrief;
  try {
    const response = await fetch(process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.1, messages: [
        { role: 'system', content: 'You are a financial auditor. Analyze only the supplied report context and JSON rows. Do not invent figures, fields, dates, hotels, or explanations. Return JSON with headline, summary, warnings (array), and auditStatus.' },
        { role: 'user', content: JSON.stringify({ report: context, dataset: rows }) }
      ], response_format: { type: 'json_object' } })
    });
    if (!response.ok) throw new Error(`Brief model returned ${response.status}`);
    const result = await response.json();
    const parsed = JSON.parse(result.choices?.[0]?.message?.content || '{}');
    return { ...datasetBrief, ...parsed, warnings: Array.isArray(parsed.warnings) ? parsed.warnings : datasetBrief.warnings, scope: datasetBrief.scope, fields: datasetBrief.fields };
  } catch (err) {
    return { ...datasetBrief, modelNotice: 'LLM unavailable; brief generated from the returned dataset.' };
  }
}

app.post('/api/ai-reports/query', async (req, res) => {
  try {
    const type = String(req.body.prompt || '').trim() ? inferAiReport(req.body.prompt) : (req.body.type || 'daily_sales');
    const report = buildAiReport(type, req.body);
    const result = await pool.query(report.sql, report.params);
    const columns = result.rows.length ? Object.keys(result.rows[0]) : result.fields.map(field => field.name);
    const brief = await generateFinancialBrief(result.rows, { title: report.meta.title, reportType: report.type, prompt: req.body.prompt || '', property: req.body.property || 'ALL', from_date: req.body.from_date || '', to_date: req.body.to_date || '', sql: report.sql.replace(/\s+/g, ' ').trim() });
    res.json({ reportType: report.type, title: report.meta.title, columns, rows: result.rows, brief, generatedSql: report.sql.replace(/\s+/g, ' ').trim() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

const DAILY_TASKS = {
  in_out: { title: 'In & Out', sheet: 'In and Out', idEnv: 'GOOGLE_SHEETS_IN_OUT_ID', key: 'booking_reference', sourceTable: 'bookings' },
  cash: { title: 'Cash', sheet: 'Cash', idEnv: 'GOOGLE_SHEETS_CASH_ID', key: 'payment_id', method: 'cash', sourceTable: 'payments' },
  card: { title: 'Card', sheet: 'Card', idEnv: 'GOOGLE_SHEETS_CARD_ID', key: 'payment_id', method: 'card', sourceTable: 'payments' }
};

function taskDefinition(type) { if (!DAILY_TASKS[type]) throw new Error('Unknown daily task.'); return DAILY_TASKS[type]; }
async function getLiveTableColumns(tableName) {
  const result = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [tableName]);
  return result.rows.map(row => row.column_name);
}
function taskSourceQuery(type, body) {
  const task = taskDefinition(type); const params = []; const clauses = [];
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid task date is required.');
  params.push(date);
  if (body.property && body.property !== 'ALL') { params.push(String(body.property)); clauses.push(`LOWER(TRIM(${type === 'in_out' ? 'b.property_name' : 'p.property_name'})) = LOWER(TRIM($${params.length}))`); }
  if (type === 'in_out') {
    clauses.push(`(b.check_in::DATE = $1::DATE OR b.check_out::DATE = $1::DATE)`);
    return { sql: `${DISTRIBUTED_CTE} SELECT b.* FROM distributed_bookings b WHERE ${clauses.join(' AND ')} ORDER BY b.check_in, b.room_unit_name`, params };
  }
  const method = task.method === 'cash' ? "LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%cash%'" : "(LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%card%' OR LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%visa%' OR LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%mastercard%')";
  clauses.push(`COALESCE(p.payment_date, p.received_date_time)::DATE = $1::DATE`, method);
  return { sql: `SELECT p.* FROM payments p LEFT JOIN bookings b ON b.booking_reference = p.booking_reference WHERE p.is_deleted = FALSE AND ${clauses.join(' AND ')} ORDER BY p.payment_date DESC NULLS LAST, p.payment_id`, params };
}

function validateMapping(mapping, sourceColumns) {
  if (!Array.isArray(mapping) || !mapping.length) throw new Error('At least one mapped column is required.');
  const seen = new Set(); let keyCount = 0;
  mapping.forEach(item => {
    const header = String(item.header || '').trim(); const mode = item.mode === 'calculated' ? 'calculated' : 'column';
    if (!header || seen.has(header)) throw new Error('Mapped headers must be present and unique.');
    seen.add(header); if (item.isKey) keyCount += 1;
    if (mode === 'column' && !sourceColumns.includes(item.source)) throw new Error(`Unknown source column: ${item.source}`);
    if (mode === 'calculated') {
      const expression = String(item.expression || '').trim();
      const identifiers = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      if (!expression || identifiers.some(identifier => !sourceColumns.includes(identifier)) || /[^A-Za-z0-9_ +().,'&-]/.test(expression)) throw new Error(`Invalid calculated expression for ${header}.`);
    }
  });
  if (keyCount !== 1) throw new Error('Select exactly one unique key column for upsert.');
  return mapping;
}

function evaluateMapping(item, row) {
  if (item.mode !== 'calculated') return row[item.source] ?? '';
  const expression = String(item.expression || '').trim();
  const parts = expression.split('+').map(part => part.trim()).filter(Boolean);
  const values = parts.map(part => row[part] ?? part.replace(/^['"]|['"]$/g, ''));
  if (parts.length > 1 && values.every(value => !Number.isNaN(Number(value)) && String(value).trim() !== '')) return values.reduce((sum, value) => sum + Number(value), 0);
  return values.join(' ').trim();
}

async function getTaskRows(type, body) { const source = taskSourceQuery(type, body); const result = await pool.query(source.sql, source.params); return { columns: result.fields.map(field => field.name), rows: result.rows }; }

app.get('/api/daily-tasks/meta', (req, res) => res.json({ tasks: DAILY_TASKS }));
app.get('/api/daily-tasks/presets', async (req, res) => { try { taskDefinition(req.query.task); const result = await pool.query('SELECT preset_id, task_type, preset_name, mapping, updated_at FROM task_mapping_presets WHERE task_type = $1 ORDER BY preset_name', [req.query.task]); res.json(result.rows); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/daily-tasks/presets', async (req, res) => { try { const task = taskDefinition(req.body.task); const mapping = validateMapping(req.body.mapping, await getLiveTableColumns(task.sourceTable)); const name = String(req.body.name || '').trim(); if (!name) throw new Error('Preset name is required.'); const result = await pool.query(`INSERT INTO task_mapping_presets (task_type, preset_name, mapping, updated_at) VALUES ($1, $2, $3::JSONB, NOW()) ON CONFLICT (task_type, preset_name) DO UPDATE SET mapping = EXCLUDED.mapping, updated_at = NOW() RETURNING preset_id, task_type, preset_name, mapping, updated_at`, [req.body.task, name, JSON.stringify(mapping)]); res.json(result.rows[0]); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/daily-tasks/preview', async (req, res) => { try { const task = taskDefinition(req.body.task); const data = await getTaskRows(req.body.task, req.body); const mapping = validateMapping(req.body.mapping, data.columns); res.json({ task, columns: data.columns, rows: data.rows.slice(0, 50), mappedRows: data.rows.slice(0, 50).map(row => mapping.map(item => evaluateMapping(item, row))) }); } catch (err) { res.status(400).json({ error: err.message }); } });

app.post('/api/daily-tasks/sync', async (req, res) => {
  try {
    const task = taskDefinition(req.body.task); let mapping = req.body.mapping;
    if (req.body.preset_id) { const preset = await pool.query('SELECT mapping FROM task_mapping_presets WHERE preset_id = $1 AND task_type = $2', [req.body.preset_id, req.body.task]); if (!preset.rowCount) throw new Error('Selected preset was not found.'); mapping = preset.rows[0].mapping; }
    const data = await getTaskRows(req.body.task, req.body); mapping = validateMapping(mapping, data.columns); const keyItem = mapping.find(item => item.isKey); const keyIndex = mapping.indexOf(keyItem);
    const sheets = await getGoogleSheetsClient(); const spreadsheetId = process.env[task.idEnv]; if (!spreadsheetId) throw new Error(`${task.idEnv} is not configured.`);
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${task.sheet}'!A:ZZ` }); const values = existing.data.values || []; const headers = mapping.map(item => item.header); const existingHeaders = values[0] || headers; const keyHeader = keyItem.header; const existingKeyIndex = Math.max(0, existingHeaders.indexOf(keyHeader)); const rowByKey = new Map(values.slice(1).map((row, index) => [String(row[existingKeyIndex] || ''), index + 2]));
    const updates = []; const appends = []; data.rows.forEach(row => { const mapped = mapping.map(item => String(evaluateMapping(item, row))); const key = mapped[keyIndex]; const sheetRow = existingHeaders.map(header => { const index = headers.indexOf(header); return index >= 0 ? mapped[index] : ''; }); if (key && rowByKey.has(key)) updates.push({ range: `'${task.sheet}'!A${rowByKey.get(key)}`, values: [sheetRow] }); else if (key) appends.push(sheetRow); });
    if (!values.length) await sheets.spreadsheets.values.update({ spreadsheetId, range: `'${task.sheet}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [headers] } });
    if (updates.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: updates } });
    if (appends.length) await sheets.spreadsheets.values.append({ spreadsheetId, range: `'${task.sheet}'!A:ZZ`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: appends } });
    res.json({ success: true, task: task.title, updated: updates.length, inserted: appends.length, skipped: data.rows.length - updates.length - appends.length, key: keyItem.header });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ============================================================================
// [SECTION-03C]: GOOGLE SHEETS / POSTGRESQL BOOKING RECONCILIATION
// ============================================================================
const DEFAULT_RECONCILIATION_SHEET_ID = '1PY3DTpnFNTRsb-bbFiU8u7acXk7hlf9sqij6DGGAmAE';
const DEFAULT_RECONCILIATION_TAB = 'In&Out 2026';

function parseSheetCheckIn(value) {
  const rawSheetDate = String(value || '').trim();
  let normalizedSheetDate = '';
  if (rawSheetDate.includes('/')) {
    const parts = rawSheetDate.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2];
      const candidate = `${year}-${month}-${day}`;
      const parsed = new Date(`${candidate}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) normalizedSheetDate = candidate;
    }
  }
  return normalizedSheetDate;
}

function normalizeBookingReference(reference) {
  return String(reference || '').trim().toUpperCase();
}

function normalizePropertyName(property) {
  return String(property || '').replace(/\s+/g, '').toLowerCase();
}

function normalizeDateOnly(value) {
  return new Date(value).toISOString().split('T')[0];
}

function reconciliationKey(reference, checkIn) {
  return `${normalizeBookingReference(reference)}_${normalizeDateOnly(checkIn)}`;
}

function parseReconciliationDate(value, fieldName) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${fieldName} must use YYYY-MM-DD format.`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error(`${fieldName} is not a valid calendar date.`);
  return date;
}

function buildReconciliationInsights(missingInSystem, missingInSheet) {
  const discrepancies = [...missingInSystem, ...missingInSheet];
  const propertyCounts = new Map();
  const dateCounts = new Map();
  discrepancies.forEach(row => {
    const property = String(row.property_name || 'Unknown property').trim() || 'Unknown property';
    propertyCounts.set(property, (propertyCounts.get(property) || 0) + 1);
    dateCounts.set(row.check_in, (dateCounts.get(row.check_in) || 0) + 1);
  });
  const mostErrors = [...propertyCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  const highestFailureDate = [...dateCounts.entries()]
    .map(([date, count]) => ({ date, count, rate: 1 }))
    .sort((left, right) => right.rate - left.rate || right.count - left.count)[0];
  return {
    total_count: discrepancies.length,
    property_with_most_errors: mostErrors ? { property: mostErrors[0], count: mostErrors[1] } : null,
    date_with_highest_failure_rate: highestFailureDate || null
  };
}

app.post('/api/reconciliation', async (req, res) => {
  try {
    const spreadsheetId = String(req.body.sheetId || DEFAULT_RECONCILIATION_SHEET_ID).trim();
    const tabName = String(req.body.tabName || DEFAULT_RECONCILIATION_TAB).trim();
    if (!spreadsheetId || !tabName) throw new Error('Google Sheet ID and tab name are required.');
    const startDate = parseReconciliationDate(req.body.startDate, 'Start date');
    const endDate = parseReconciliationDate(req.body.endDate, 'End date');
    if (endDate < startDate) throw new Error('End date must be on or after start date.');
    const propertyName = String(req.body.propertyName || 'ALL').trim();
    const hasPropertyFilter = propertyName && propertyName.toUpperCase() !== 'ALL';
    const normalizedPropertyFilter = normalizePropertyName(propertyName);

    const sheets = await getGoogleSheetsClient(GOOGLE_SHEETS_READONLY_SCOPES);
    const escapedTabName = tabName.replace(/'/g, "''");
    const sheetResult = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${escapedTabName}'!A:AB`, majorDimension: 'ROWS' });
    const values = sheetResult.data.values || [];
    const sheetReferencesSet = new Set();
    const targetSheetRows = [];
    let skippedSheetRows = 0;

    values.slice(1).forEach(row => {
      const sheetReference = String(row[17] || '').trim().toUpperCase();
      if (!sheetReference) { skippedSheetRows += 1; return; }
      sheetReferencesSet.add(sheetReference);
      const checkIn = parseSheetCheckIn(row[0]);
      const property = String(row[27] || '').trim();
      if (checkIn && checkIn >= startDate && checkIn <= endDate && (!hasPropertyFilter || normalizePropertyName(property) === normalizedPropertyFilter)) {
        targetSheetRows.push({
          booking_reference: sheetReference,
          check_in: checkIn,
          guest_name: String(row[8] || '').trim(),
          property_name: property,
          raw_sheet_row: row
        });
      }
    });

    const dbResult = await pool.query(`
            SELECT b.*,
              check_in::DATE AS check_in,
              check_out::DATE AS check_out,
              CONCAT_WS(' ', guest_first_name, guest_last_name) AS guest_name,
              telephone AS guest_phone,
              email AS guest_email,
              COALESCE(adults, 0) + COALESCE(children, 0) AS number_of_guests,
              nights,
              channel AS booking_source,
              booking_status AS status,
              NULL::TEXT AS payment_status,
              COALESCE(
                CASE WHEN raw_data->>'room_rate' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (raw_data->>'room_rate')::NUMERIC END,
                CASE WHEN raw_data->>'price_per_night' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (raw_data->>'price_per_night')::NUMERIC END
              ) AS room_rate,
              COALESCE(other_revenue, 0) AS other_revenue,
              COALESCE(NULLIF(TRIM(booking_notes), ''), NULLIF(TRIM(notes), '')) AS booking_notes,
              total_revenue AS total_price,
              total_revenue AS booked_amount,
              COALESCE(
                (SELECT STRING_AGG(method, ', ' ORDER BY method)
                 FROM (
                   SELECT DISTINCT NULLIF(TRIM(p.payment_method), '') AS method
                   FROM payments p
                   WHERE REGEXP_REPLACE(UPPER(TRIM(p.booking_reference)), '\\s+', '', 'g') = REGEXP_REPLACE(UPPER(TRIM(b.booking_reference)), '\\s+', '', 'g')
                     AND p.is_deleted = FALSE
                     AND COALESCE(p.amount, 0) > 0
                     AND NULLIF(TRIM(p.payment_method), '') IS NOT NULL
                 ) positive_payment_methods),
                (SELECT NULLIF(TRIM(rp.payment_method), '')
                 FROM reservation_payments rp
                 WHERE REGEXP_REPLACE(UPPER(TRIM(rp.booking_reference)), '\\s+', '', 'g') = REGEXP_REPLACE(UPPER(TRIM(b.booking_reference)), '\\s+', '', 'g')
                 ORDER BY payment_date DESC NULLS LAST, payment_id DESC LIMIT 1),
                ''
              ) AS payment_methods,
              property_name,
              room_unit_name
      FROM bookings AS b
      WHERE check_in::DATE >= $1::DATE AND check_in::DATE <= $2::DATE
        ${hasPropertyFilter ? 'AND REGEXP_REPLACE(LOWER(COALESCE(property_name, \'\')), \'\\s+\', \'\', \'g\') = $3' : ''}
      ORDER BY check_in, booking_reference;
    `, hasPropertyFilter ? [startDate, endDate, normalizedPropertyFilter] : [startDate, endDate]);

    const dbRows = dbResult.rows.map(dbRecord => {
      const roomRate = parseFloat(dbRecord.room_unit_revenue || dbRecord.room_rate || dbRecord.raw_data?.room_unit_revenue || dbRecord.raw_data?.room_rate || dbRecord.raw_data?.price_per_night || 0) || 0;
      const otherRev = parseFloat(dbRecord.other_revenue || 0) || 0;
      const total = parseFloat(dbRecord.total_revenue || 0) || 0;
      const paid = parseFloat(dbRecord.paid_amount || 0) || 0;
      const source = String(dbRecord.booking_source || '').toLowerCase().trim();
      let paymentStatus = '';
      let appendedNote = '';

      if (paid === 0 || total === 0 || source === 'direct') {
        paymentStatus = 'Payment on arrival';
      } else if (paid >= roomRate) {
        paymentStatus = 'Pre-paid';
        if (otherRev > 0) appendedNote = paid >= total ? ' | ✅ Other revenue paid' : ' | 🔴 Other revenue not paid';
      } else if (paid > 0 && paid < roomRate) {
        paymentStatus = 'Payment on arrival';
        appendedNote = ' | ⚠️ Room rate partially paid';
      }

      const originalNote = String(dbRecord.notes || dbRecord.booking_notes || '').trim();
      const cleanAppendedNote = appendedNote.replace(/^\s*\|\s*/, '').trim();
      const finalNote = cleanAppendedNote
        ? (originalNote ? `${cleanAppendedNote} | ${originalNote}` : cleanAppendedNote)
        : originalNote;
      const prepaidOta = /(expedia\s*collect|booking\.com\s*vcc|booking\s*vcc|virtual\s*card|prepaid)/i.test(source);
      const paymentMethod = paid >= roomRate
        ? String(dbRecord.payment_methods || (prepaidOta && paymentStatus === 'Pre-paid' ? 'Pre-paid' : '')).trim()
        : '';
      return {
        ...dbRecord,
        check_in: normalizeDateOnly(dbRecord.check_in),
        room_unit_revenue: roomRate,
        room_rate: roomRate,
        other_revenue: otherRev,
        payment_status: paymentStatus,
        payment_method: paymentMethod,
        booking_notes: finalNote
      };
    });
    const missingInSheet = dbRows.filter(dbRecord => {
      const dbReference = String(dbRecord.booking_reference || '').trim().toUpperCase();
      return dbReference && !sheetReferencesSet.has(dbReference);
    });
    const targetReferences = [...new Set(targetSheetRows.map(row => row.booking_reference))];
    let existingTargetReferences = new Set();
    if (targetReferences.length) {
      const targetDbResult = await pool.query(`
        SELECT DISTINCT REGEXP_REPLACE(UPPER(TRIM(booking_reference)), '\\s+', '', 'g') AS normalized_reference
        FROM bookings
        WHERE REGEXP_REPLACE(UPPER(TRIM(booking_reference)), '\\s+', '', 'g') = ANY($1::TEXT[]);
      `, [targetReferences.map(reference => normalizeBookingReference(reference))]);
      existingTargetReferences = new Set(targetDbResult.rows.map(row => row.normalized_reference));
    }
    const missingInSystem = targetSheetRows.filter(row => !existingTargetReferences.has(normalizeBookingReference(row.booking_reference)));
    console.log('[Reconciliation] DB references sample:', dbRows.slice(0, 3).map(dbRecord => String(dbRecord.booking_reference || '').trim().toUpperCase()));
    console.log('[Reconciliation] Sheet references sample:', [...sheetReferencesSet].slice(0, 3));
    const insights = buildReconciliationInsights(missingInSystem, missingInSheet);
    res.json({
      date_range: { from: startDate, to: endDate },
      property_name: hasPropertyFilter ? propertyName : 'ALL',
      skipped_sheet_rows: skippedSheetRows,
      summary: { total_discrepancies: missingInSystem.length + missingInSheet.length, missing_in_system: missingInSystem.length, missing_in_sheet: missingInSheet.length },
      insights,
      missing_in_system: missingInSystem,
      missing_in_sheet: missingInSheet,
      missingInSystem,
      missingInSheet
    });
  } catch (err) {
    console.error('Booking reconciliation error:', err.message);
    res.status(400).json({ error: err.message });
  }
});
// ============================================================================
// [SECTION-04]: SMART GLOBAL SEARCH (HANDLES REVERSED NAMES)
// ============================================================================
app.get('/api/bookings/search', async (req, res) => {
  try {
    const searchString = String(req.query.q || '').trim();
    if (!searchString) return res.json([]);

    const parts = searchString.split(/\s+/);
    const queryParams = [`%${searchString}%`];
    let nameCondition = `CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $1`;

    if (parts.length === 2) {
      const reversedString = `${parts[1]} ${parts[0]}`;
      nameCondition = `(CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $1 OR CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $2)`;
      queryParams.push(`%${reversedString}%`);
    }

    const result = await pool.query(`
      ${DISTRIBUTED_CTE}
      SELECT ${sharedSelectSQL}
      FROM distributed_bookings AS b
      WHERE ${nameCondition}
         OR b.booking_reference ILIKE $1
         OR b.order_reference ILIKE $1
         OR b.telephone ILIKE $1
         OR b.email ILIKE $1
      ORDER BY b.check_in DESC
      LIMIT 15;
    `, queryParams);

    res.json(result.rows);
  } catch (err) {
    console.error('Global booking search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bookings/:ref', async (req, res) => {
  try {
    const bookingReference = String(req.params.ref || '').trim();
    if (!bookingReference) return res.status(400).json({ error: 'Booking reference is required.' });

    const result = await pool.query(`
      ${DISTRIBUTED_CTE}
      SELECT ${bookingDetailSelectSQL}
      FROM distributed_bookings b
      WHERE b.booking_reference = $1
      LIMIT 1;
    `, [bookingReference]);

    if (!result.rows.length) return res.status(404).json({ error: 'Booking not found.' });

    const booking = result.rows[0];
    const allocation = await applyGroupPaymentWaterfall([booking]);
    const groupKey = bookingGroupKey(booking);
    const groupMembers = allocation.groups.get(groupKey);
    if (groupMembers && groupMembers.length > 1) {
      const totalGroupGuests = groupMembers.reduce(
        (total, member) => total + Number(member.adults || 0) + Number(member.children || 0),
        0
      );
      return res.json({
        ...allocation.rows[0],
        group_members: groupMembersWithAllocation(groupMembers, allocation.allocatedByReference),
        total_group_paid: groupMembers.reduce((total, member) => total + Number(member.recorded_paid_amount || 0), 0),
        total_group_guests: totalGroupGuests
      });
    }

    res.json(allocation.rows[0]);
  } catch (err) {
    console.error('Booking detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// [SECTION-05]: UNPAID RESERVATIONS
// ============================================================================
app.get('/api/reservations/unpaid', async (req, res) => {
  try {
    const { property, from_date, to_date, search, limit = 50, offset = 0 } = req.query;
    let whereClauses = [`(b.total_revenue::numeric - b.distributed_paid_amount) > 0`, `LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')`];
    const params = [];

    if (property && property !== 'ALL') { params.push(property.trim()); whereClauses.push(`TRIM(b.property_name) ILIKE $${params.length}`); }
    if (from_date && to_date) { params.push(from_date, to_date); whereClauses.push(`b.check_in::DATE >= $${params.length - 1}::DATE AND b.check_in::DATE <= $${params.length}::DATE`); }
    if (search && search.trim()) { params.push(`%${search.trim()}%`); whereClauses.push(`(b.booking_reference ILIKE $${params.length} OR CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $${params.length} OR b.order_reference ILIKE $${params.length})`); }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;
    const summaryQuery = `${DISTRIBUTED_CTE} SELECT COUNT(*)::int AS total_unpaid_count, COALESCE(SUM(b.total_revenue::numeric), 0)::numeric AS total_booked_amount, COALESCE(SUM(b.total_revenue::numeric - b.distributed_paid_amount), 0)::numeric AS total_outstanding FROM distributed_bookings b ${whereSql};`;
    const summaryResult = await pool.query(summaryQuery, params);
    
    const dataParams = [...params, parseInt(limit, 10), parseInt(offset, 10)];
    const dataResult = await pool.query(`${DISTRIBUTED_CTE} SELECT ${sharedSelectSQL} FROM distributed_bookings b ${whereSql} ORDER BY CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ASC NULLS LAST, b.check_in ASC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length};`, dataParams);
    
    res.json({ total: summaryResult.rows[0]?.total_unpaid_count || 0, summary: summaryResult.rows[0] || {}, data: dataResult.rows || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// [SECTION-06]: DAILY OPERATIONS
// ============================================================================
app.get('/api/operations/daily', async (req, res) => {
  try {
    const { property, date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date is required.' });
    let propertyCondition = ''; const queryParams = [date];
    const properties = String(property || '').split(',').map(value => value.trim()).filter(value => value && value !== 'ALL');
    if (properties.length) { queryParams.push(properties); propertyCondition = `AND TRIM(b.property_name) ILIKE ANY($2::TEXT[])`; }

    const baseQuery = (dateCol) => `${DISTRIBUTED_CTE} SELECT ${sharedSelectSQL}, CASE WHEN b.distributed_paid_amount <= 0 THEN 'Payment on Arrival / Unpaid' WHEN b.distributed_paid_amount < b.total_revenue::numeric THEN 'Partially Paid' ELSE 'Fully Prepaid' END AS payment_status FROM distributed_bookings b WHERE b.${dateCol}::DATE = $1::DATE ${propertyCondition} AND LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled') ORDER BY b.room_unit_name ASC, b.check_in ASC;`;
    const [arrRes, depRes] = await Promise.all([pool.query(baseQuery('check_in'), queryParams), pool.query(baseQuery('check_out'), queryParams)]);
    const allocation = await applyGroupPaymentWaterfall([...arrRes.rows, ...depRes.rows]);
    const allocatedRows = new Map(allocation.rows.map(row => [row.booking_reference, row]));
    res.json({
      arrivals: arrRes.rows.map(row => allocatedRows.get(row.booking_reference) || row),
      departures: depRes.rows.map(row => allocatedRows.get(row.booking_reference) || row)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/operations/duplicate-guests', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid date is required.' });

    const query = `${DISTRIBUTED_CTE}
      SELECT ${sharedSelectSQL},
        LOWER(REGEXP_REPLACE(TRIM(CONCAT_WS(' ', b.guest_first_name, b.guest_last_name)), '\\s+', ' ', 'g')) AS guest_key
      FROM distributed_bookings b
      WHERE b.check_in::DATE = $1::DATE
        AND LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')
        AND NULLIF(TRIM(CONCAT_WS(' ', b.guest_first_name, b.guest_last_name)), '') IS NOT NULL
        AND LOWER(REGEXP_REPLACE(TRIM(CONCAT_WS(' ', b.guest_first_name, b.guest_last_name)), '\\s+', ' ', 'g')) <> 'reserved ical'
      ORDER BY guest_key, b.property_name, b.check_in ASC;`;
    const result = await pool.query(query, [date]);
    const groups = new Map();

    result.rows.forEach(row => {
      const key = row.guest_key;
      if (!groups.has(key)) groups.set(key, { guest_name: row.guest_name, reservations: [], properties: new Set() });
      const group = groups.get(key);
      if (!group.reservations.some(item => item.booking_reference === row.booking_reference)) {
        group.reservations.push(row);
        group.properties.add((row.property_name || '').trim().toLowerCase());
      }
    });

    res.json([...groups.values()]
      .filter(group => group.properties.size > 1)
      .map(group => ({ guest_name: group.guest_name, property_count: group.properties.size, reservations: group.reservations })));
  } catch (err) {
    console.error('Duplicate guest lookup error:', err.message);
    res.status(500).json({ error: 'Unable to load duplicate guest suggestions.' });
  }
});

// ============================================================================
// [SECTION-07]: UPDATE BOOKING, ADD PAYMENTS & DELETE
// ============================================================================
app.post('/api/reservations/:ref/update', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    const { guest_name, telephone, email, company_name, company_vat, channel, booking_status, room_unit_name, room_unit_type, property_name, notes, check_in, check_out, address_line, city, postcode } = req.body;
    
    const nameParts = (guest_name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const query = `
      UPDATE bookings SET 
        guest_first_name = $1, guest_last_name = $2, telephone = $3, email = $4,
        company_name = $5, company_vat = $6, channel = $7, booking_status = COALESCE(NULLIF($8, ''), booking_status), room_unit_name = $9, property_name = $10, notes = $11,
        room_unit_type = COALESCE(NULLIF($12, ''), room_unit_type), check_in = COALESCE(NULLIF($13, '')::DATE, check_in), check_out = COALESCE(NULLIF($14, '')::DATE, check_out),
        address_line = $15, city = $16, postcode = $17
      WHERE booking_reference = $18 RETURNING *;
    `;
    await client.query('BEGIN');
    const updated = await client.query(query, [firstName, lastName, telephone, email, company_name, company_vat, channel, booking_status, room_unit_name, property_name, notes, room_unit_type, check_in || '', check_out || '', address_line || '', city || '', postcode || '', ref]);
    if (!updated.rowCount) throw new Error('Reservation not found.');
    if (['canceled', 'cancelled'].includes(String(booking_status || '').trim().toLowerCase())) {
      const ghost = await client.query(`SELECT total_revenue, paid_amount FROM bookings WHERE booking_reference = $1`, [ref]);
      if (Number(ghost.rows[0].total_revenue || 0) === 0 && Number(ghost.rows[0].paid_amount || 0) === 0) {
        await client.query('DELETE FROM bookings WHERE booking_reference = $1', [ref]);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, booking: updated.rows[0] });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.put('/api/bookings/:ref', async (req, res) => {
  try {
    const ref = String(req.params.ref || '').trim();
    const totalAmount = Number(req.body.total_amount ?? req.body.total_revenue);
    const propertyName = String(req.body.property_name || '').trim();
    const roomName = String(req.body.room_name ?? req.body.room_unit_name ?? '').trim();
    if (!ref || !Number.isFinite(totalAmount) || totalAmount < 0 || !propertyName || !roomName) {
      return res.status(400).json({ error: 'Booking reference, non-negative total amount, property, and room are required.' });
    }
    const result = await pool.query(`
      UPDATE bookings
      SET total_revenue = $1, property_name = $2, room_unit_name = $3
      WHERE booking_reference = $4
      RETURNING *;
    `, [totalAmount.toFixed(2), propertyName, roomName, ref]);
    if (!result.rowCount) return res.status(404).json({ error: 'Reservation not found.' });
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/reservations', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      booking_reference, property_name, room_unit_name, guest_name, check_in, check_out,
      total_revenue = 0, paid_amount = 0, channel = 'Direct', booking_status = 'Confirmed',
      telephone = '', email = '', notes = '', company_name = '', company_vat = '', adults = 1, children = 0
    } = req.body;
    const reference = String(booking_reference || '').trim();
    const property = String(property_name || '').trim();
    const room = String(room_unit_name || '').trim();
    const guest = String(guest_name || '').trim();
    const checkIn = String(check_in || '').trim();
    const checkOut = String(check_out || '').trim();
    const revenue = Number(total_revenue);
    const paid = Number(paid_amount);
    const adultCount = Number(adults);
    const childCount = Number(children);

    if (!property || !room || !guest || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      return res.status(400).json({ error: 'Property, room, guest, check-in, and check-out are required.' });
    }
    if (checkOut <= checkIn) return res.status(400).json({ error: 'Check-out must be after check-in.' });
    if (!Number.isFinite(revenue) || revenue < 0 || !Number.isFinite(paid) || paid < 0 || paid > revenue) return res.status(400).json({ error: 'Amounts must be valid, non-negative, and paid cannot exceed the total.' });
    if (!Number.isInteger(adultCount) || adultCount < 1 || !Number.isInteger(childCount) || childCount < 0) return res.status(400).json({ error: 'Guest counts are invalid.' });
    if (booking_status !== 'Confirmed' && booking_status !== 'Canceled') return res.status(400).json({ error: 'Booking status must be Confirmed or Canceled.' });

    const nameParts = guest.split(/\s+/);
    const firstName = nameParts.shift() || '';
    const lastName = nameParts.join(' ');
    const nights = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000);
    if (!Number.isInteger(nights) || nights < 1) return res.status(400).json({ error: 'Check-in and check-out must be valid calendar dates.' });
    const generatedReference = reference || `MAN-${Date.now().toString(36).toUpperCase()}`;

    await client.query('BEGIN');
    const duplicate = await client.query('SELECT 1 FROM bookings WHERE booking_reference = $1', [generatedReference]);
    if (duplicate.rowCount > 0) throw new Error('A booking with this reference already exists.');
    if (booking_status !== 'Canceled') {
      const overlap = await client.query(`
        SELECT booking_reference FROM bookings
        WHERE LOWER(TRIM(property_name)) = LOWER(TRIM($1))
          AND LOWER(TRIM(room_unit_name)) = LOWER(TRIM($2))
          AND LOWER(TRIM(COALESCE(booking_status, ''))) NOT IN ('canceled', 'cancelled')
          AND check_in < $4::DATE AND check_out > $3::DATE
        LIMIT 1;
      `, [property, room, checkIn, checkOut]);
      if (overlap.rowCount > 0) throw new Error(`Room is already booked for those dates (${overlap.rows[0].booking_reference}).`);
    }

    await client.query(`
      INSERT INTO bookings (
        booking_reference, property_name, guest_first_name, guest_last_name, telephone, email,
        room_unit_name, booking_status, channel, notes, company_name, company_vat,
        check_in, check_out, nights, adults, children, currency, total_revenue, paid_amount, booking_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::DATE, $14::DATE, $15, $16, $17, 'GBP', $18, $19, NOW())
    `, [generatedReference, property, firstName, lastName, telephone, email, room, booking_status, channel, notes, company_name, company_vat, checkIn, checkOut, nights, adultCount, childCount, revenue, paid]);

    if (paid > 0) {
      await client.query(`
        INSERT INTO reservation_payments (booking_reference, order_reference, amount, payment_method, description, payment_date)
        VALUES ($1, $1, $2, 'Manual Entry', 'Initial payment', NOW())
      `, [generatedReference, paid]);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, booking_reference: generatedReference });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/reservations/:ref/status', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    const requestedStatus = String(req.body.booking_status || '').trim().toLowerCase();
    const bookingStatus = requestedStatus === 'canceled' || requestedStatus === 'cancelled' ? 'Canceled' : requestedStatus === 'confirmed' ? 'Confirmed' : null;
    if (!bookingStatus) return res.status(400).json({ error: 'Booking status must be Confirmed or Canceled.' });

    await client.query('BEGIN');
    const result = await client.query('UPDATE bookings SET booking_status = $1 WHERE booking_reference = $2 RETURNING booking_reference, booking_status, total_revenue, paid_amount;', [bookingStatus, ref]);
    if (result.rowCount === 0) throw new Error('Reservation not found.');
    if (bookingStatus === 'Canceled' && Number(result.rows[0].total_revenue || 0) === 0 && Number(result.rows[0].paid_amount || 0) === 0) {
      await client.query('DELETE FROM bookings WHERE booking_reference = $1', [ref]);
    }
    await client.query('COMMIT');
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) { await client.query('ROLLBACK'); res.status(err.message === 'Reservation not found.' ? 404 : 500).json({ error: err.message }); } finally { client.release(); }
});

app.post('/api/reservations/:ref/payments', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    const { amount, payment_method, card_brand, card_last_four, description, user_name } = req.body;
    const parsedAmount = parseFloat(amount || 0);

    if (isNaN(parsedAmount) || parsedAmount === 0) return res.status(400).json({ error: 'Valid amount required.' });

    await client.query('BEGIN');
    const bookingRes = await client.query('SELECT order_reference FROM bookings WHERE booking_reference = $1 FOR UPDATE', [ref]);
    if (bookingRes.rowCount === 0) throw new Error('Reservation not found.');

    const pRes = await client.query(`
      INSERT INTO reservation_payments (booking_reference, order_reference, amount, payment_method, card_brand, card_last_four, description, payment_date, user_name, last_updated_date_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, NOW()) RETURNING *;
    `, [ref, bookingRes.rows[0].order_reference || ref, parsedAmount, payment_method, card_brand || null, card_last_four || null, description, String(user_name || 'Portal User').trim() || 'Portal User']);

    await recalculateBookingPaidAmount(client, ref);
    await client.query('COMMIT');
    res.status(201).json({ success: true, payment: pRes.rows[0] });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.delete('/api/payments/:payment_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { payment_id } = req.params;
    await client.query('BEGIN');

    const paymentRes = await client.query('DELETE FROM reservation_payments WHERE payment_id = $1 RETURNING booking_reference, amount, payment_method', [payment_id]);
    if (paymentRes.rowCount === 0) throw new Error('Record not found.');

    const ref = paymentRes.rows[0].booking_reference;
    await recalculateBookingPaidAmount(client, ref);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.put('/api/payments/:payment_id', async (req, res) => {
  try {
    const paymentId = Number.parseInt(req.params.payment_id, 10);
    const amount = Number(req.body.amount);
    const method = String(req.body.payment_method || '').trim();
    const description = String(req.body.description || '').trim();
    if (!Number.isInteger(paymentId) || paymentId <= 0 || !Number.isFinite(amount) || amount === 0 || !method) return res.status(400).json({ error: 'Payment ID, non-zero amount, method, and description are required.' });
    const result = await pool.query(`
      UPDATE reservation_payments
      SET amount = $1, payment_method = $2, description = $3, last_updated_date_time = NOW(), user_name = $4
      WHERE payment_id = $5
      RETURNING *;
    `, [amount, method, description, String(req.body.user_name || 'Portal User').trim() || 'Portal User', paymentId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Manual payment record not found.' });
    await recalculateBookingPaidAmount(pool, result.rows[0].booking_reference);
    res.json({ success: true, payment: result.rows[0] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/payments/imported/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const amount = Number(req.body.amount);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(amount)) return res.status(400).json({ error: 'Imported payment ID and valid amount are required.' });
    const result = await pool.query(`UPDATE payments SET amount = $1, payment_method = COALESCE(NULLIF($2, ''), payment_method), payment_status = COALESCE(NULLIF($3, ''), payment_status), last_updated_date_time = NOW(), user_name = $4 WHERE id = $5 AND is_deleted = FALSE RETURNING *`, [amount, String(req.body.payment_method || '').trim(), String(req.body.payment_status || '').trim(), String(req.body.user_name || 'Portal User').trim() || 'Portal User', id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Imported payment record not found.' });
    await recalculateBookingPaidAmount(pool, result.rows[0].booking_reference);
    res.json({ success: true, payment: result.rows[0] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/payments/imported/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'A valid imported payment ID is required.' });
    const result = await pool.query('UPDATE payments SET is_deleted = TRUE, last_updated_date_time = NOW(), user_name = $1 WHERE id = $2 AND is_deleted = FALSE RETURNING booking_reference', [String(req.body.user_name || 'Portal User').trim() || 'Portal User', id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Imported payment record not found.' });
    await recalculateBookingPaidAmount(pool, result.rows[0].booking_reference);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/reservations/:ref/charges', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    const amount = Number(req.body.amount);
    const description = String(req.body.description || '').trim();
    const category = String(req.body.category || 'Ad Hoc').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !description) throw new Error('A positive amount and description are required.');
    await client.query('BEGIN');
    const booking = await client.query('SELECT booking_reference FROM bookings WHERE booking_reference = $1 FOR UPDATE', [ref]);
    if (!booking.rowCount) throw new Error('Reservation not found.');
    const charge = await client.query(`INSERT INTO reservation_charges (booking_reference, category, description, amount) VALUES ($1, $2, $3, $4) RETURNING *`, [ref, category, description, amount]);
    await client.query('UPDATE bookings SET total_revenue = COALESCE(total_revenue, 0) + $1 WHERE booking_reference = $2', [amount, ref]);
    await recalculateBookingPaidAmount(client, ref);
    await client.query('COMMIT');
    res.status(201).json({ success: true, charge: charge.rows[0] });
  } catch (err) { await client.query('ROLLBACK'); res.status(400).json({ error: err.message }); } finally { client.release(); }
});

app.delete('/api/reservations/:ref/charges/:chargeId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref, chargeId } = req.params;
    await client.query('BEGIN');
    const charge = await client.query('DELETE FROM reservation_charges WHERE charge_id = $1 AND booking_reference = $2 RETURNING amount', [chargeId, ref]);
    if (!charge.rowCount) throw new Error('Charge not found.');
    await client.query('UPDATE bookings SET total_revenue = COALESCE(total_revenue, 0) - $1 WHERE booking_reference = $2', [charge.rows[0].amount, ref]);
    await recalculateBookingPaidAmount(client, ref);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(400).json({ error: err.message }); } finally { client.release(); }
});

app.post('/api/reservations/:ref/cards', async (req, res) => {
  try {
    const { ref } = req.params;
    const { cardholder_name, card_brand, last_four, expiry_month, expiry_year } = req.body;
    if (!String(cardholder_name || '').trim()) return res.status(400).json({ error: 'Cardholder name is required.' });
    const result = await pool.query(`INSERT INTO booking_cards (booking_reference, cardholder_name, card_brand, last_four, expiry_month, expiry_year) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [ref, cardholder_name, card_brand || null, String(last_four || '').slice(-4), expiry_month || null, expiry_year || null]);
    res.status(201).json({ success: true, card: result.rows[0] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/reservations/:ref/cards/:cardId', async (req, res) => {
  try { const result = await pool.query('DELETE FROM booking_cards WHERE card_id = $1 AND booking_reference = $2 RETURNING card_id', [req.params.cardId, req.params.ref]); if (!result.rowCount) return res.status(404).json({ error: 'Card not found.' }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservations/:ref/messages', async (req, res) => {
  try { const text = String(req.body.message_text || '').trim(); if (!text) return res.status(400).json({ error: 'Message text is required.' }); const result = await pool.query('INSERT INTO booking_messages (booking_reference, message_type, message_text) VALUES ($1, $2, $3) RETURNING *', [req.params.ref, req.body.message_type || 'Internal Note', text]); res.status(201).json({ success: true, message: result.rows[0] }); } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/reservations/:ref/messages/:messageId', async (req, res) => {
  try { const result = await pool.query('DELETE FROM booking_messages WHERE message_id = $1 AND booking_reference = $2 RETURNING message_id', [req.params.messageId, req.params.ref]); if (!result.rowCount) return res.status(404).json({ error: 'Message not found.' }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservations/:ref/waive', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    await client.query('BEGIN');
    const booking = await client.query(`
      SELECT booking_reference, order_reference, total_revenue, paid_amount
      FROM bookings WHERE booking_reference = $1 FOR UPDATE;
    `, [ref]);
    if (!booking.rowCount) throw new Error('Reservation not found.');
    const balance = Math.max(0, Number(booking.rows[0].total_revenue || 0) - Number(booking.rows[0].paid_amount || 0));
    if (balance <= 0) throw new Error('There is no positive balance to waive.');
    const description = String(req.body.description || 'Balance waived by Finance').trim().slice(0, 500);
    const waiver = await client.query(`
      INSERT INTO reservation_payments (booking_reference, order_reference, amount, payment_method, description, payment_date)
      VALUES ($1, $2, $3, 'Waive/Discount', $4, NOW()) RETURNING *;
    `, [ref, booking.rows[0].order_reference || ref, -balance, description]);
    await client.query(`
      UPDATE bookings
      SET paid_amount = COALESCE(total_revenue, 0)
      WHERE booking_reference = $1;
    `, [ref]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, waiver: waiver.rows[0], waived_amount: balance });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/reservations/:ref/deposit-waive', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    const requestedAmount = Number(req.body.amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) throw new Error('A positive deposit waiver amount is required.');
    await client.query('BEGIN');
    const booking = await client.query(`
      SELECT booking_reference, order_reference, COALESCE(other_revenue, 0) AS other_revenue,
             COALESCE((SELECT SUM(-amount) FROM reservation_payments WHERE booking_reference = $1 AND payment_method = 'Deposit Waive/Discount'), 0) AS waived_deposit
      FROM bookings WHERE booking_reference = $1 FOR UPDATE;
    `, [ref]);
    if (!booking.rowCount) throw new Error('Reservation not found.');
    const deposit = Number(booking.rows[0].other_revenue || 0);
    const waivedDeposit = Math.max(0, Number(booking.rows[0].waived_deposit || 0));
    const remainingDeposit = Math.max(0, deposit - waivedDeposit);
    const waiverAmount = Math.min(requestedAmount, remainingDeposit);
    if (waiverAmount <= 0) throw new Error('There is no remaining deposit to waive.');
    const description = String(req.body.description || 'Damage deposit waived by Finance').trim().slice(0, 500);
    const waiver = await client.query(`
      INSERT INTO reservation_payments (booking_reference, order_reference, amount, payment_method, description, payment_date)
      VALUES ($1, $2, $3, 'Deposit Waive/Discount', $4, NOW()) RETURNING *;
    `, [ref, booking.rows[0].order_reference || ref, -waiverAmount, description]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, waiver: waiver.rows[0], waived_amount: waiverAmount, remaining_deposit: remainingDeposit - waiverAmount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/api/reservations/:ref', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    await client.query('BEGIN');
    await client.query('DELETE FROM reservation_payments WHERE booking_reference = $1', [ref]);
    await client.query('DELETE FROM reservation_charges WHERE booking_reference = $1', [ref]);
    await client.query('DELETE FROM booking_cards WHERE booking_reference = $1', [ref]);
    await client.query('DELETE FROM booking_messages WHERE booking_reference = $1', [ref]);
    const result = await client.query('DELETE FROM bookings WHERE booking_reference = $1 RETURNING *', [ref]);
    if (result.rowCount === 0) throw new Error('Reservation not found.');
    await client.query('COMMIT');
    res.json({ success: true, message: `Reservation ${ref} deleted.` });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// ============================================================================
// [SECTION-08]: CALENDAR FEED
// ============================================================================
app.get('/api/calendar/feed', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    const startDate = String(req.query.start_date || '').trim();
    const endDate = String(req.query.end_date || '').trim();
    if (!property || property === 'ALL' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ error: 'Property, start_date, and end_date are required.' });
    }

    const roomQuery = `
      SELECT MIN(TRIM(room_unit_name)) AS room_unit_name
      FROM bookings
      WHERE LOWER(TRIM(property_name)) = LOWER(TRIM($1))
        AND room_unit_name IS NOT NULL
        AND TRIM(room_unit_name) <> ''
      GROUP BY LOWER(TRIM(room_unit_name))
      ORDER BY LOWER(TRIM(room_unit_name));
    `;
    const bookingQuery = `
      ${DISTRIBUTED_CTE}
      SELECT ${sharedSelectSQL}
      FROM distributed_bookings b
      WHERE LOWER(TRIM(b.property_name)) = LOWER(TRIM($1))
        AND b.check_in IS NOT NULL
        AND b.check_out IS NOT NULL
        AND b.check_in::DATE <= $3::DATE
        AND b.check_out::DATE > $2::DATE
      ORDER BY b.room_unit_name ASC, b.check_in ASC, b.check_out ASC;
    `;
    const [roomsResult, bookingsResult] = await Promise.all([
      pool.query(roomQuery, [property]),
      pool.query(bookingQuery, [property, startDate, endDate])
    ]);

    res.json({
      rooms: roomsResult.rows.map(row => row.room_unit_name),
      bookings: bookingsResult.rows
    });
  } catch (err) {
    console.error('Calendar feed error:', err.message);
    res.status(500).json({ error: 'Unable to load calendar data.' });
  }
});

// ============================================================================
// [SECTION-09]: ZOHO CLIQ WEBHOOK DISPATCHER
// ============================================================================
app.post('/api/operations/send-cliq', async (req, res) => {
  try {
    const { property, date, arrivals = [], departures = [] } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required.' });

    const hotelTitle = property && property !== 'ALL' ? property : 'All Portfolio Properties';
    const sanitizedKey = property ? property.toUpperCase().replace(/[^A-Z0-9]/g, '_') : '';
    const webhookUrl = process.env[`ZOHO_CLIQ_WEBHOOK_${sanitizedKey}`] || process.env.ZOHO_CLIQ_WEBHOOK;

    if (!webhookUrl) return res.status(404).json({ error: `No Webhook found.` });

    const totalDue = arrivals.reduce((acc, r) => acc + Math.max(0, parseFloat(r.balance_due || 0)), 0);
    const unpaidCount = arrivals.filter(r => parseFloat(r.balance_due || 0) > 0).length;

    let text = `🏨 *Daily Operational Handover — ${hotelTitle}*\n📅 *Target Date:* ${date}\n━━━━━━━━━━━━━━━━━━━━\n📊 *Summary:* 📥 Arrivals: *${arrivals.length}* | 📤 Departures: *${departures.length}*\n💰 *Pending Collect on Arrival:* *£${totalDue.toFixed(2)}* (${unpaidCount} bookings)\n\n`;

    text += `📥 *EXPECTED ARRIVALS:*\n`;
    if (arrivals.length === 0) text += `_No expected arrivals._\n\n`;
    else {
      arrivals.forEach((a, idx) => {
        const bal = parseFloat(a.balance_due || 0);
        const payTag = bal > 0 ? `⚠️ *Collect £${bal.toFixed(2)}*` : `✅ *Settled*`;
        text += `${idx + 1}. *${a.room_unit_name || 'Room N/A'}* — *${a.guest_name}* (${a.channel || 'Direct'})\n   └ Status: ${payTag}${a.telephone ? ' | 📞 '+a.telephone : ''}\n`;
      }); text += `\n`;
    }

    text += `📤 *EXPECTED DEPARTURES:*\n`;
    if (departures.length === 0) text += `_No expected departures._\n`;
    else {
      departures.forEach((d, idx) => {
        const bal = parseFloat(d.balance_due || 0);
        const depStatus = bal > 0 ? `⚠️ *Pending Balance £${bal.toFixed(2)}*` : `✅ *Cleared*`;
        text += `${idx + 1}. *${d.room_unit_name || 'Room N/A'}* — *${d.guest_name}* | ${depStatus}\n`;
      });
    }

    const cliqRes = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, card: { title: `Daily Handover: ${hotelTitle}`, theme: 'modern-inline' } }) });
    if (!cliqRes.ok) throw new Error(await cliqRes.text());
    res.json({ success: true, message: `Handover briefing sent to Zoho Cliq for ${hotelTitle}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// [SECTION-09]: SERVER BOOTSTRAPPER
// ============================================================================
app.listen(PORT, () => console.log(`🚀 Hospitality Management Portal active at: http://localhost:${PORT}`));
