DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;

CREATE TABLE bookings (
    id SERIAL PRIMARY KEY,
    booking_reference VARCHAR(100) UNIQUE NOT NULL,
    order_reference VARCHAR(100),
    ota_reference VARCHAR(100),
    property_name VARCHAR(255),
    guest_first_name VARCHAR(100),
    guest_last_name VARCHAR(100),
    telephone VARCHAR(50),
    email VARCHAR(255),
    room_unit_name VARCHAR(255),
    room_unit_type VARCHAR(255),
    booking_status VARCHAR(100),
    channel VARCHAR(100),
    currency VARCHAR(10) DEFAULT 'GBP',
    notes TEXT,
    booking_notes TEXT,
    company_name VARCHAR(255),
    company_vat VARCHAR(100),
    booking_date TIMESTAMP,
    check_in DATE,
    check_out DATE,
    nights INT,
    adults INT DEFAULT 0,
    children INT DEFAULT 0,
    other_revenue NUMERIC(12, 2),
    total_revenue NUMERIC(12, 2),
    paid_amount NUMERIC(12, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    raw_data JSONB NOT NULL DEFAULT '{}'::JSONB
);

-- جدول المدفوعات (Payments)
CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    payment_id VARCHAR(100) NOT NULL,
    unique_payment_key VARCHAR(255) NOT NULL,
    booking_reference VARCHAR(100),
    order_reference VARCHAR(100),
    received_date_time TIMESTAMP,
    guest_name VARCHAR(255),
    business_name VARCHAR(255),
    room_name VARCHAR(255),
    channel VARCHAR(100),
    channel_reference VARCHAR(100),
    payment_type VARCHAR(100),
    payment_method VARCHAR(100),
    property_name VARCHAR(255),
    currency VARCHAR(10) DEFAULT 'GBP',
    payment_status VARCHAR(100),
    payment_date TIMESTAMP,
    amount NUMERIC(10, 2),
    user_name VARCHAR(255) NOT NULL DEFAULT 'Eviivo Import',
    last_updated_date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    raw_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payments_unique_payment_key UNIQUE (unique_payment_key)
);

-- Migration for databases created before the composite payment identity.
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
DELETE FROM payments older
USING payments newer
WHERE older.payment_id = newer.payment_id
  AND older.booking_reference IS NOT DISTINCT FROM newer.booking_reference
  AND (older.last_updated_date_time, older.id) < (newer.last_updated_date_time, newer.id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_booking_unique_idx
    ON payments(payment_id, booking_reference);
CREATE UNIQUE INDEX IF NOT EXISTS payments_unique_payment_key_idx ON payments(unique_payment_key);
CREATE INDEX IF NOT EXISTS idx_imported_payments_booking_ref
    ON payments(booking_reference) WHERE is_deleted = FALSE;

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

CREATE INDEX IF NOT EXISTS idx_reservation_payments_booking_ref ON reservation_payments(booking_reference);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_name VARCHAR(255) NOT NULL DEFAULT 'Eviivo Import';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_updated_date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reservation_payments ADD COLUMN IF NOT EXISTS user_name VARCHAR(255) NOT NULL DEFAULT 'Portal User';
ALTER TABLE reservation_payments ADD COLUMN IF NOT EXISTS last_updated_date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS petty_expenses (
    id SERIAL PRIMARY KEY,
    property_name VARCHAR(255) NOT NULL,
    manager_name VARCHAR(255) NOT NULL,
    expense_date DATE NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    receipt_image_url TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_petty_expenses_property_date
    ON petty_expenses(property_name, expense_date);

ALTER TABLE petty_expenses
    ALTER COLUMN amount TYPE NUMERIC(10, 2)
    USING ROUND(amount::numeric, 2);

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

CREATE INDEX IF NOT EXISTS idx_monthly_settlements_month
    ON monthly_settlements(settlement_month, property_name);