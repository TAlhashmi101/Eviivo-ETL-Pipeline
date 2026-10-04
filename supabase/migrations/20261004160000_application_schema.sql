CREATE TABLE IF NOT EXISTS public.bookings (
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
    raw_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    address_line TEXT,
    city VARCHAR(120),
    postcode VARCHAR(30)
);

CREATE TABLE IF NOT EXISTS public.payments (
    id SERIAL PRIMARY KEY,
    payment_id VARCHAR(100) NOT NULL,
    unique_payment_key VARCHAR(255),
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.reservation_payments (
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

CREATE TABLE IF NOT EXISTS public.reservation_charges (
    charge_id SERIAL PRIMARY KEY,
    booking_reference VARCHAR(100) NOT NULL,
    category VARCHAR(100) NOT NULL DEFAULT 'Ad Hoc',
    description TEXT NOT NULL,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    charge_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.booking_cards (
    card_id SERIAL PRIMARY KEY,
    booking_reference VARCHAR(100) NOT NULL,
    cardholder_name VARCHAR(255) NOT NULL,
    card_brand VARCHAR(50),
    last_four VARCHAR(4),
    expiry_month VARCHAR(2),
    expiry_year VARCHAR(4),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.booking_messages (
    message_id SERIAL PRIMARY KEY,
    booking_reference VARCHAR(100) NOT NULL,
    message_type VARCHAR(40) NOT NULL DEFAULT 'Internal Note',
    message_text TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.task_mapping_presets (
    preset_id SERIAL PRIMARY KEY,
    task_type VARCHAR(30) NOT NULL,
    preset_name VARCHAR(120) NOT NULL,
    mapping JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.petty_expenses (
    id SERIAL PRIMARY KEY,
    property_name VARCHAR(255) NOT NULL,
    manager_name VARCHAR(255) NOT NULL,
    expense_date DATE NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    receipt_image_url TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.monthly_settlements (
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
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS order_reference VARCHAR(100);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS ota_reference VARCHAR(100);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS room_unit_type VARCHAR(255);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS booking_status VARCHAR(100);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS channel VARCHAR(100);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'GBP';
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS booking_notes TEXT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS company_name VARCHAR(255);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS company_vat VARCHAR(100);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS booking_date TIMESTAMP;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS check_in DATE;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS check_out DATE;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS nights INT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS adults INT DEFAULT 0;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS children INT DEFAULT 0;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS other_revenue NUMERIC(12, 2);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS total_revenue NUMERIC(12, 2);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12, 2);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS raw_data JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS address_line TEXT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS city VARCHAR(120);
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS postcode VARCHAR(30);

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS unique_payment_key VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS order_reference VARCHAR(100);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS received_date_time TIMESTAMP;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS guest_name VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS business_name VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS room_name VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS channel VARCHAR(100);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS channel_reference VARCHAR(100);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_type VARCHAR(100);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS property_name VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'GBP';
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(100);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_date TIMESTAMP;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS amount NUMERIC(10, 2);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS user_name VARCHAR(255) NOT NULL DEFAULT 'Eviivo Import';
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS last_updated_date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS raw_data JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE public.reservation_payments ADD COLUMN IF NOT EXISTS order_reference VARCHAR(100);
ALTER TABLE public.reservation_payments ADD COLUMN IF NOT EXISTS card_brand VARCHAR(50);
ALTER TABLE public.reservation_payments ADD COLUMN IF NOT EXISTS card_last_four VARCHAR(4);
ALTER TABLE public.reservation_payments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.reservation_payments ADD COLUMN IF NOT EXISTS payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE public.reservation_payments ADD COLUMN IF NOT EXISTS user_name VARCHAR(255) NOT NULL DEFAULT 'Portal User';
ALTER TABLE public.reservation_payments ADD COLUMN IF NOT EXISTS last_updated_date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
DECLARE constraint_record RECORD;
BEGIN
    FOR constraint_record IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE n.nspname = 'public'
          AND t.relname = 'payments'
          AND c.contype = 'u'
        GROUP BY c.conname
        HAVING COUNT(*) = 1 AND BOOL_AND(a.attname = 'payment_id')
    LOOP
        EXECUTE format('ALTER TABLE public.payments DROP CONSTRAINT %I', constraint_record.conname);
    END LOOP;
END $$;

DROP INDEX IF EXISTS public.payments_payment_id_unique;
DROP INDEX IF EXISTS public.payments_identity_idx;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_booking_reference_unique_idx
    ON public.bookings(booking_reference);
CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_booking_unique_idx
    ON public.payments(payment_id, booking_reference);
CREATE UNIQUE INDEX IF NOT EXISTS payments_unique_payment_key_idx
    ON public.payments(unique_payment_key) WHERE unique_payment_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_mapping_presets_task_name_unique_idx
    ON public.task_mapping_presets(task_type, preset_name);
CREATE UNIQUE INDEX IF NOT EXISTS monthly_settlements_property_month_unique_idx
    ON public.monthly_settlements(property_name, settlement_month);

CREATE INDEX IF NOT EXISTS idx_bookings_check_in ON public.bookings(check_in);
CREATE INDEX IF NOT EXISTS idx_bookings_check_out ON public.bookings(check_out);
CREATE INDEX IF NOT EXISTS idx_imported_payments_booking_ref
    ON public.payments(booking_reference) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_reservation_payments_booking_ref
    ON public.reservation_payments(booking_reference);
CREATE INDEX IF NOT EXISTS idx_charges_booking_ref
    ON public.reservation_charges(booking_reference);
CREATE INDEX IF NOT EXISTS idx_booking_cards_ref
    ON public.booking_cards(booking_reference);
CREATE INDEX IF NOT EXISTS idx_booking_messages_ref
    ON public.booking_messages(booking_reference);
CREATE INDEX IF NOT EXISTS idx_petty_expenses_property_date
    ON public.petty_expenses(property_name, expense_date);
CREATE INDEX IF NOT EXISTS idx_monthly_settlements_month
    ON public.monthly_settlements(settlement_month, property_name);

DO $$
BEGIN
    IF to_regclass('public."Booking"') IS NOT NULL THEN
        EXECUTE $migrate_bookings$
            INSERT INTO public.bookings (
                booking_reference, order_reference, ota_reference, property_name,
                guest_first_name, room_unit_name, booking_status, currency,
                booking_date, check_in, check_out, nights, other_revenue,
                total_revenue, paid_amount, created_at, raw_data
            )
            SELECT
                NULLIF(BTRIM(b."bookingReference"), ''),
                NULLIF(BTRIM(b."masterBookingRef"), ''),
                NULLIF(BTRIM(b."otaReference"), ''),
                NULLIF(BTRIM(b.property), ''),
                NULLIF(BTRIM(b."guestName"), ''),
                NULLIF(BTRIM(b.room), ''),
                NULLIF(BTRIM(b.status), ''),
                'GBP',
                b."createdAt",
                b."checkIn"::date,
                b."checkOut"::date,
                CASE
                    WHEN b."checkIn" IS NOT NULL AND b."checkOut" IS NOT NULL
                    THEN GREATEST(b."checkOut"::date - b."checkIn"::date, 0)
                END,
                b."otherRevenue"::numeric,
                b."totalRevenue"::numeric,
                b."paidAmount"::numeric,
                b."createdAt",
                jsonb_build_object(
                    '_migration_source', 'public."Booking"',
                    '_legacy_id', b.id,
                    'Room/Unit Revenue', b."roomRevenue",
                    'Other Revenue', b."otherRevenue",
                    'Damage Deposit', b."damageDeposit",
                    'Total Revenue', b."totalRevenue",
                    'Paid Amount', b."paidAmount",
                    'Group', b."masterBookingRef",
                    'OTA Reference', b."otaReference",
                    'legacy_metadata', b.metadata
                )
            FROM public."Booking" b
            WHERE NULLIF(BTRIM(b."bookingReference"), '') IS NOT NULL
            ON CONFLICT (booking_reference) DO NOTHING
        $migrate_bookings$;
    END IF;

    IF to_regclass('public."Payment"') IS NOT NULL
       AND to_regclass('public."Booking"') IS NOT NULL THEN
        EXECUTE $migrate_payments$
            INSERT INTO public.payments (
                payment_id, unique_payment_key, booking_reference, order_reference,
                received_date_time, guest_name, business_name, room_name,
                channel_reference, payment_type, payment_method, property_name,
                currency, payment_date, amount, user_name, raw_data
            )
            SELECT
                COALESCE(NULLIF(BTRIM(p."paymentReference"), ''), 'legacy:' || p.id),
                p.id,
                NULLIF(BTRIM(p."bookingRef"), ''),
                NULLIF(BTRIM(b."masterBookingRef"), ''),
                p."paymentDate",
                NULLIF(BTRIM(b."guestName"), ''),
                NULLIF(BTRIM(b.property), ''),
                NULLIF(BTRIM(b.room), ''),
                NULLIF(BTRIM(p."otaReference"), ''),
                NULLIF(BTRIM(p.description), ''),
                NULLIF(BTRIM(p."paymentMethod"), ''),
                NULLIF(BTRIM(b.property), ''),
                'GBP',
                p."paymentDate",
                p.amount::numeric,
                COALESCE(NULLIF(BTRIM(p."userName"), ''), 'Legacy Supabase Import'),
                jsonb_build_object(
                    '_migration_source', 'public."Payment"',
                    '_legacy_id', p.id,
                    'Payment Reference', p."paymentReference",
                    'Booking Reference', p."bookingRef",
                    'OTA Reference', p."otaReference",
                    'Payment Date', p."paymentDate",
                    'Payment Method', p."paymentMethod",
                    'Description', p.description,
                    'legacy_metadata', p.metadata
                )
            FROM public."Payment" p
            LEFT JOIN public."Booking" b
                ON b."bookingReference" = p."bookingRef"
            ON CONFLICT DO NOTHING
        $migrate_payments$;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NOT NULL THEN
        EXECUTE $storage$
            INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
            VALUES ('receipts', 'receipts', TRUE, 8388608, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
            ON CONFLICT (id) DO NOTHING
        $storage$;
    END IF;
END $$;
