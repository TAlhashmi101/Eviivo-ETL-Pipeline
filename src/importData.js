const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const csv = require('csv-parser');
const pool = require('./db');

// --- Helper: توحيد صيغ التواريخ ---
function parseSafeDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const val = dateStr.trim();
  if (!val) return null;

  // 1. ISO format: keep only the source calendar date, never parse the time zone.
  const isoMatch = val.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  // 2. Slash format (e.g. 26/07/2025 19:31 or 01/09/2026)
  const slashMatch = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // 3. Dashed text format (e.g. 01-Sep-2026)
  const monthMap = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };
  const dashMatch = val.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/i);
  if (dashMatch) {
    const [, day, mon, year] = dashMatch;
    const monthNum = monthMap[mon.toLowerCase()] || '01';
    return `${year}-${monthNum}-${day.padStart(2, '0')}`;
  }

  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function paymentDateKey(dateStr) {
  const date = parseSafeDate(dateStr);
  if (!date) return '';
  return `${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}`;
}

function parseEviivoTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/);
  if (match) {
    const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = new Date(year, monthMap[match[2].toLowerCase()], Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] || 0), Number(`0.${match[7] || 0}`) * 1000);
    if (!Number.isNaN(date.getTime())) {
      const pad = number => String(number).padStart(2, '0');
      return `${year}-${pad(Number(match[2] ? monthMap[match[2].toLowerCase()] + 1 : date.getMonth() + 1))}-${pad(Number(match[1]))} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
    }
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

// --- Helper: تنظيف الأرقام والعملات (£129.00 -> 129.00) ---
function parseSafeFloat(val) {
  if (val === undefined || val === null || val === '') return 0.0;
  const raw = String(val).trim();
  const isParenthesizedNegative = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[^0-9.-]+/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0.0;
  return isParenthesizedNegative ? -Math.abs(num) : num;
}

function parseSafeInt(val) {
  if (val === undefined || val === null || val === '') return 0;
  const cleaned = String(val).replace(/[^0-9-]+/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

function sqlIdentifier(value, fallback = 'source_column') {
  const normalized = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^\d+/, '_$&').replace(/^_+|_+$/g, '') || fallback;
  return normalized;
}

async function ensureSourceColumns(client, tableName, headers, reserved) {
  const used = new Set(reserved);
  const mapping = [];
  headers.forEach((header, index) => {
    const base = sqlIdentifier(header, `source_column_${index + 1}`);
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}_${suffix++}`;
    used.add(name);
    mapping.push({ header, name });
  });
  if (mapping.length) {
    await client.query(`ALTER TABLE ${tableName} ${
      mapping.map(item => `ADD COLUMN IF NOT EXISTS "${item.name}" TEXT`).join(', ')
    }`);
  }
  return mapping;
}

function valuesForSourceColumns(row, mapping) { return mapping.map(item => row[item.header] ?? null); }

function paymentIdentityKey(paymentId, bookingReference, orderReference) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([paymentId, bookingReference, orderReference]))
    .digest('hex');
}

async function deactivatePriorPaymentRows(client, paymentIdentities) {
  const uniqueIdentities = [...new Map(paymentIdentities.map(identity => [
    `${identity.paymentId}\u0000${String(identity.propertyName || '').trim().toUpperCase()}`,
    identity
  ])).values()];
  if (!uniqueIdentities.length) return;

  await client.query(`
    UPDATE payments
    SET is_deleted = TRUE
    FROM UNNEST($1::text[], $2::text[]) AS incoming(payment_id, property_name)
    WHERE (
        payments.payment_id::text = incoming.payment_id
        OR payments.payment_id::text = incoming.payment_id || '-' || payments.booking_reference
      )
      AND UPPER(TRIM(COALESCE(payments.property_name, ''))) = UPPER(TRIM(incoming.property_name))
      AND payments.is_deleted = FALSE;
  `, [
    uniqueIdentities.map(identity => String(identity.paymentId)),
    uniqueIdentities.map(identity => String(identity.propertyName || ''))
  ]);
}

function firstSourceValue(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return row[name];
  }
  return null;
}

function bookingFinancialsFromRow(row) {
  const roomRevenue = parseSafeFloat(firstSourceValue(row, [
    'Room/Unit Revenue', 'Room Unit Revenue', 'room_unit_revenue', 'Room Rate', 'room_rate'
  ]));
  const otherRevenue = parseSafeFloat(firstSourceValue(row, [
    'Other Revenue', 'OtherRevenue', 'other_revenue'
  ]));
  const reportedRevenue = parseSafeFloat(firstSourceValue(row, [
    'Total Revenue', 'Total Amount', 'total_revenue'
  ]));
  const paidAmount = parseSafeFloat(firstSourceValue(row, [
    'Paid Amount', 'Payment', 'Paid', 'paid_amount'
  ]));
  const positiveOtherRevenue = Math.max(0, otherRevenue);
  const roomRevenueBase = Math.max(
    0,
    roomRevenue || (reportedRevenue !== 0
      ? reportedRevenue >= positiveOtherRevenue ? reportedRevenue - positiveOtherRevenue : reportedRevenue
      : 0)
  );
  const reportedOtherRevenue = Math.min(
    positiveOtherRevenue,
    Math.max(0, reportedRevenue - roomRevenueBase)
  );
  const paidDeposit = Math.min(
    positiveOtherRevenue,
    Math.max(0, paidAmount - roomRevenueBase)
  );
  const totalRevenue = Math.max(
    0,
    roomRevenueBase,
    reportedRevenue !== 0
      ? reportedRevenue - reportedOtherRevenue + paidDeposit
      : roomRevenueBase + paidDeposit
  );

  return {
    roomRevenue,
    otherRevenue,
    totalRevenue,
    paidAmount
  };
}

function shouldImportBooking(bookingStatus, totalRevenue, paidAmount) {
  const cancelled = /^cancell?ed$/i.test(String(bookingStatus || '').trim());
  if (cancelled) return paidAmount > 0;
  return totalRevenue !== 0 || paidAmount > 0;
}

function valueFromHeaders(row, headers, names, fallbackIndex) {
  for (const name of names) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const header = headers.find(candidate => String(candidate).toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedName);
    const value = header ? row[header] : undefined;
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  const fallbackHeader = headers[fallbackIndex];
  return fallbackHeader && row[fallbackHeader] !== undefined ? String(row[fallbackHeader]).trim() : '';
}

function paymentMethodFromRow(row, allHeaders = []) {
  return valueFromHeaders(row, allHeaders, ['PaymentMethod', 'Payment Method'], 55);
}

function isOnAccountTransfer(row, allHeaders = []) {
  const fields = [
    paymentMethodFromRow(row, allHeaders),
    valueFromHeaders(row, allHeaders, ['PaymentType', 'Payment Type', 'Type'], 52),
    valueFromHeaders(row, allHeaders, ['PaymentType2', 'Payment Status'], 52)
  ];
  return fields.some(value => /^on\s+account(?:\b|$)/i.test(String(value || '').trim()));
}

function paymentAmountFromRow(row, allHeaders = []) {
  const candidates = ['Direct1', 'Total Paid', 'SettledAmount', 'OTAPrepaid1', 'Amount'];
  let firstValue;
  for (const candidate of candidates) {
    const value = valueFromHeaders(row, allHeaders, [candidate], -1);
    if (!value) continue;
    if (firstValue === undefined) firstValue = value;
    const amount = parseSafeFloat(value);
    if (amount !== 0) return amount;
  }
  if (firstValue !== undefined) return parseSafeFloat(firstValue);
  return parseSafeFloat(valueFromHeaders(row, allHeaders, [], 72));
}

function findMasterPaymentRow(entries, allHeaders = []) {
  return entries.find(entry => {
    return paymentAmountFromRow(entry.row, allHeaders) !== 0
      && !isOnAccountTransfer(entry.row, allHeaders);
  });
}

function bookingRate(booking) {
  const raw = booking?.raw_data && typeof booking.raw_data === 'object' ? booking.raw_data : {};
  return bookingFinancialsFromRow({
    ...raw,
    'Total Revenue': firstSourceValue(raw, ['Total Revenue', 'Total Amount', 'total_revenue']) ?? booking?.total_revenue,
    'Room/Unit Revenue': firstSourceValue(raw, [
      'Room/Unit Revenue', 'Room Unit Revenue', 'room_unit_revenue', 'Room Rate', 'room_rate'
    ]),
    'Other Revenue': booking?.other_revenue ?? firstSourceValue(raw, ['Other Revenue', 'OtherRevenue', 'other_revenue']),
    'Paid Amount': firstSourceValue(raw, ['Paid Amount', 'Payment', 'Paid', 'paid_amount']) ?? booking?.paid_amount
  }).totalRevenue;
}

async function allocateGroupPayment(client, { orderReference, bookingReference, amount, groupBookings }) {
  const normalizedOrderReference = String(orderReference || '').trim();
  if (!normalizedOrderReference) return [];

  let bookings = groupBookings;
  if (!Array.isArray(bookings)) {
    const result = await client.query(`
    SELECT b.booking_reference, b.room_unit_name, b.total_revenue, b.other_revenue,
           b.raw_data, b.id, b.booking_status, b.paid_amount,
           COALESCE((
             SELECT SUM(p.amount::numeric)
             FROM payments p
             WHERE p.booking_reference = b.booking_reference
               AND p.is_deleted = FALSE
               AND LOWER(TRIM(COALESCE(p.payment_status, ''))) !~ '(fail|declin|cancel|void|pending|reject|unpaid|error)'
               AND LOWER(TRIM(COALESCE(p.payment_method, ''))) !~ '^on account'
               AND LOWER(TRIM(COALESCE(p.payment_status, ''))) !~ '^on account'
           ), 0) AS actual_paid_amount
    FROM bookings b
    WHERE UPPER(TRIM(COALESCE(b.order_reference, ''))) = UPPER($1)
       OR UPPER(TRIM(COALESCE(b.raw_data->>'Group', ''))) = UPPER($1)
    ORDER BY id
    FOR UPDATE;
  `, [normalizedOrderReference]);
    bookings = result.rows || [];
  }

  const allocations = bookings
    .filter(booking => shouldImportBooking(
      booking.booking_status,
      bookingRate(booking),
      Math.max(parseSafeFloat(booking.paid_amount), parseSafeFloat(booking.actual_paid_amount))
    ))
    .map(booking => ({
      bookingReference: booking.booking_reference,
      roomId: booking.room_unit_name || booking.booking_reference,
      amountBase: bookingRate(booking)
    }))
    .filter(allocation => allocation.bookingReference);

  if (!allocations.length) return [];

  const totalCents = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(totalCents)) {
    throw new Error(`Group payment allocation failed: invalid payment amount for ${normalizedOrderReference}`);
  }

  const referencedBooking = bookings.find(booking =>
    String(booking.booking_reference || '').trim().toUpperCase() === String(bookingReference || '').trim().toUpperCase()
  );
  if (referencedBooking) {
    const expectedRevenue = bookingRate(referencedBooking);
    const reportedPaid = parseSafeFloat(referencedBooking.paid_amount);
    const tolerance = 0.01;
    if (
      expectedRevenue > 0
      && Math.abs(reportedPaid - expectedRevenue) <= tolerance
      && Math.abs(totalCents) / 100 <= expectedRevenue + tolerance
    ) {
      return [{
        bookingReference: referencedBooking.booking_reference,
        roomId: referencedBooking.room_unit_name || referencedBooking.booking_reference,
        amount: totalCents / 100
      }];
    }
  }

  const absoluteCents = Math.abs(totalCents);
  const totalBase = allocations.reduce((sum, item) => sum + Number(item.amountBase || 0), 0);
  const weights = totalBase > 0
    ? allocations.map(item => Number(item.amountBase || 0) / totalBase)
    : allocations.map(() => 1 / allocations.length);
  const shares = allocations.map((allocation, index) => {
    const exactCents = absoluteCents * weights[index];
    return { allocation, index, cents: Math.floor(exactCents), remainder: exactCents % 1 };
  });
  let remainingCents = absoluteCents - shares.reduce((sum, share) => sum + share.cents, 0);
  [...shares]
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .slice(0, remainingCents)
    .forEach(share => { share.cents += 1; });

  const sign = Math.sign(totalCents);
  return shares.map(({ allocation, cents }) => ({
    bookingReference: allocation.bookingReference,
    roomId: allocation.roomId,
    amount: sign * cents / 100
  }));
}

// --- 1. استيراد الحجوزات (Bookings) ---
async function importBookings(filePath, groupName) {
  return new Promise((resolve, reject) => {
    const rows = [];
    console.log(`\n⏳ [مجموعة: ${groupName}] استيراد حجوزات من: ${path.basename(filePath)}`);

    // تخطي توجيه sep= التابع لـ Eviivo
    const fileHead = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 50);
    const shouldSkip = fileHead.trim().toLowerCase().startsWith('sep=');

    fs.createReadStream(filePath)
      .pipe(csv({
        skipLines: shouldSkip ? 1 : 0,
        mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim()
      }))
      .on('data', (data) => rows.push(data))
      .on('error', (err) => reject(err))
      .on('end', async () => {
        const client = await pool.connect();
        let insertedCount = 0;

        try {
          await client.query('BEGIN');

          const headers = Object.keys(rows[0] || {});
          const sourceMapping = await ensureSourceColumns(client, 'bookings', headers, new Set(['id', 'booking_reference', 'order_reference', 'property_name', 'guest_first_name', 'guest_last_name', 'telephone', 'email', 'room_unit_name', 'booking_status', 'channel', 'currency', 'notes', 'booking_date', 'check_in', 'check_out', 'nights', 'adults', 'children', 'other_revenue', 'total_revenue', 'paid_amount', 'created_at', 'raw_data']));

          for (const row of rows) {
            // عمود C: Booking Reference بمسافة
            const bookingRef = (row['Booking Reference'] || row['Reference'] || '').trim();
            if (!bookingRef) continue;

            const orderRef = (row['Order Reference'] || '').trim();
            // عمود Property لاسم الفندق
            let propertyName = (row['Property'] || groupName).trim();

            const guestFirstName = (row['Guest First Name'] || row['First Name'] || '').trim();
            const guestLastName = (row['Guest Last Name'] || row['Last Name'] || '').trim();
            const telephone = (row['Guest Phone 1'] || row['Guest Phone 2'] || row['Telephone'] || '').trim();
            const email = (row['Guest Email'] || row['Email'] || '').trim();

            let roomUnitName = (row['Room/Unit Name'] || row['Room'] || '').trim();
            if (
              propertyName.trim().toLowerCase() === 'savoy hotel' &&
              /brichfield|birchfield|hirschfeld/i.test(roomUnitName)
            ) {
              propertyName = 'Birchfield Hotel';
              roomUnitName = roomUnitName.replace(/\s*(?:brichfield|birchfield|hirschfeld)\s*/gi, ' ').trim();
              console.log('TRANSFORMED:', roomUnitName, '->', propertyName);
              if (Object.prototype.hasOwnProperty.call(row, 'Property')) row['Property'] = propertyName;
              if (Object.prototype.hasOwnProperty.call(row, 'Room/Unit Name')) row['Room/Unit Name'] = roomUnitName;
              if (Object.prototype.hasOwnProperty.call(row, 'Room')) row.Room = roomUnitName;
            }
            const bookingStatus = (row['Booking Status'] || row['Status'] || 'Confirmed').trim();
            const channel = (row['Channel'] || row['Source'] || 'Direct').trim();
            const currency = (row['Currency'] || 'GBP').trim();
            const bookingNotes = (row['Booking Notes'] || row['Notes'] || '').trim();

            const bookingDate = parseSafeDate(row['Booking Date'] || row['Booking Date and Time']);
            const checkIn = parseSafeDate(row['Check In']);
            const checkOut = parseSafeDate(row['Check Out']);

            const nights = parseSafeInt(row['Nights']) || 1;
            const adults = parseSafeInt(row['Adults']) || 1;
            const children = parseSafeInt(row['Children']) || 0;

            const { otherRevenue, totalRevenue, paidAmount } = bookingFinancialsFromRow(row);
            if (!shouldImportBooking(bookingStatus, totalRevenue, paidAmount)) continue;

            const query = `
              INSERT INTO bookings (
                booking_reference, order_reference, property_name,
                guest_first_name, guest_last_name, telephone, email,
                room_unit_name, booking_status, channel, currency,
                notes,
                booking_date, check_in, check_out,
                nights, adults, children,
                other_revenue, total_revenue, paid_amount, raw_data,
                ${sourceMapping.map(item => `"${item.name}"`).join(', ')}
              ) VALUES (
                $1, $2, $3,
                $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12,
                $13, $14, $15,
                $16, $17, $18,
                $19, $20, $21, $22,
                ${sourceMapping.map((_, index) => `$${23 + index}`).join(', ')}
              )
              ON CONFLICT (booking_reference) DO UPDATE SET
                order_reference = EXCLUDED.order_reference,
                property_name = EXCLUDED.property_name,
                guest_first_name = EXCLUDED.guest_first_name,
                guest_last_name = EXCLUDED.guest_last_name,
                telephone = EXCLUDED.telephone,
                email = EXCLUDED.email,
                room_unit_name = EXCLUDED.room_unit_name,
                -- IMMUTABLE: UNIVERSAL TERMINAL CANCELLED STATE
                booking_status = CASE
                  WHEN LOWER(TRIM(bookings.booking_status)) IN ('cancelled', 'canceled')
                    THEN bookings.booking_status
                  ELSE EXCLUDED.booking_status
                END,
                channel = EXCLUDED.channel,
                currency = EXCLUDED.currency,
                notes = EXCLUDED.notes,
                booking_date = EXCLUDED.booking_date,
                check_in = EXCLUDED.check_in,
                check_out = EXCLUDED.check_out,
                nights = EXCLUDED.nights,
                adults = EXCLUDED.adults,
                children = EXCLUDED.children,
                other_revenue = EXCLUDED.other_revenue,
                total_revenue = EXCLUDED.total_revenue,
                paid_amount = EXCLUDED.paid_amount,
                raw_data = EXCLUDED.raw_data,
                ${sourceMapping.map(item => `"${item.name}" = EXCLUDED."${item.name}"`).join(', ')};
            `;

            const params = [
              bookingRef, orderRef, propertyName,
              guestFirstName, guestLastName, telephone, email,
              roomUnitName, bookingStatus, channel, currency,
              bookingNotes, bookingDate, checkIn, checkOut,
              nights, adults, children,
              otherRevenue, totalRevenue, paidAmount, JSON.stringify(row),
              ...valuesForSourceColumns(row, sourceMapping)
            ];

            await client.query(query, params);
            insertedCount++;
          }

          await client.query('COMMIT');
          console.log(`✅ تم استيراد/تحديث ${insertedCount} حجز بنجاح.`);
          resolve(insertedCount);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`❌ خطأ أثناء معالجة حجوزات ${groupName}:`, err.message);
          reject(err);
        } finally {
          client.release();
        }
      });
  });
}

// --- 2. استيراد المدفوعات (Payments) ---
async function importPayments(filePath, groupName) {
  return new Promise((resolve, reject) => {
    const rows = [];
    console.log(`\n⏳ [مجموعة: ${groupName}] استيراد مدفوعات من: ${path.basename(filePath)}`);

    fs.createReadStream(filePath)
      .pipe(csv({
        mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim()
      }))
      .on('data', (data) => rows.push(data))
      .on('error', (err) => reject(err))
      .on('end', async () => {
        const client = await pool.connect();
        let insertedCount = 0;
        try {
          await client.query('BEGIN');
          const allHeaders = Object.keys(rows[0] || {});
          const sourceHeaders = allHeaders.slice(38, 75);
          const sourceMapping = await ensureSourceColumns(client, 'payments', sourceHeaders, new Set(['id', 'payment_id', 'unique_payment_key', 'booking_reference', 'order_reference', 'received_date_time', 'guest_name', 'business_name', 'room_name', 'channel', 'channel_reference', 'payment_type', 'payment_method', 'property_name', 'currency', 'payment_status', 'payment_date', 'amount', 'user_name', 'last_updated_date_time', 'is_deleted', 'created_at', 'raw_data']));
          const paymentGroups = new Map();
          rows.forEach((candidate, candidateIndex) => {
            const candidateOrderRef = valueFromHeaders(candidate, allHeaders, [
              'OrderReference', 'Order Reference', 'Order Ref.', 'GroupReference', 'Group Reference'
            ], 43);
            const candidatePaymentId = valueFromHeaders(candidate, allHeaders, ['PaymentID', 'Payment ID'], 37);
            const groupKey = candidateOrderRef && candidatePaymentId
              ? `${candidateOrderRef.toUpperCase()}\u0000${candidatePaymentId}`
              : `__single_${candidateIndex}`;
            if (!paymentGroups.has(groupKey)) paymentGroups.set(groupKey, []);
            paymentGroups.get(groupKey).push({ row: candidate, rowIndex: candidateIndex });
          });

          const importEntries = [];
          for (const groupRows of paymentGroups.values()) {
            const masterEntry = findMasterPaymentRow(groupRows, allHeaders);
            if (!masterEntry) continue;
            const row = masterEntry.row;
            if (isOnAccountTransfer(row, allHeaders)) continue;
            const bookingRef = valueFromHeaders(row, allHeaders, [
              'BookingReference', 'Booking Reference', 'Booking Ref.'
            ], 44);
            const orderRef = valueFromHeaders(row, allHeaders, [
              'OrderReference', 'Order Reference', 'Order Ref.', 'GroupReference', 'Group Reference'
            ], 43);
            const rawPaymentId = valueFromHeaders(row, allHeaders, ['PaymentID', 'Payment ID'], 37);
            const rawRoomId = valueFromHeaders(row, allHeaders, ['RoomId', 'Room ID', 'Room'], 42);
            const receivedDateValue = valueFromHeaders(row, allHeaders, [
              'ReceivedDateTime', 'Payment Date', 'BookedDate'
            ], 36);
            if (!rawPaymentId || !bookingRef || !paymentDateKey(receivedDateValue)) continue;

            const propertyName = String(row['business_name'] || row['Property'] || groupName).trim();
            const amount = paymentAmountFromRow(row, allHeaders);
            if (!Number.isFinite(amount) || amount === 0) continue;

            const paymentDate = parseSafeDate(receivedDateValue);
            importEntries.push({
              row,
              rawPaymentId,
              bookingRef,
              orderRef,
              rawRoomId,
              propertyName,
              amount,
              paymentDate,
              paymentMethod: paymentMethodFromRow(row, allHeaders),
              paymentStatus: valueFromHeaders(row, allHeaders, [
                'PaymentType2', 'Payment Status', 'Type'
              ], 52) || 'Success',
              userName: String(row['UserName'] || row.User || '').trim() || 'Eviivo Import',
              lastUpdatedDateTime: parseEviivoTimestamp(row['LastUpdatedDateTime'] || row.Updated) || paymentDate,
              sourceData: JSON.stringify(Object.fromEntries(sourceHeaders.map(header => [header, row[header] ?? null]))),
              sourceValues: valuesForSourceColumns(row, sourceMapping)
            });
          }

          const paymentIdentities = importEntries.map(entry => ({
            paymentId: entry.rawPaymentId,
            propertyName: entry.propertyName
          }));
          const orderReferences = [...new Set(importEntries
            .map(entry => entry.orderRef.trim().toLowerCase())
            .filter(Boolean))];
          const groupBookingsByReference = new Map();

          if (orderReferences.length) {
            const paymentIds = paymentIdentities.map(identity => identity.paymentId);
            const propertyNames = paymentIdentities.map(identity => identity.propertyName);
            const groupResult = await client.query(`
              SELECT b.booking_reference, b.room_unit_name, b.total_revenue, b.other_revenue,
                     b.raw_data, b.id, b.booking_status, b.paid_amount,
                     b.order_reference, b.raw_data->>'Group' AS group_reference,
                     COALESCE(paid.actual_paid_amount, 0) AS actual_paid_amount
              FROM bookings b
              LEFT JOIN (
                SELECT p.booking_reference, SUM(p.amount::numeric) AS actual_paid_amount
                FROM payments p
                WHERE p.is_deleted = FALSE
                  AND LOWER(TRIM(COALESCE(p.payment_status, ''))) !~ '(fail|declin|cancel|void|pending|reject|unpaid|error)'
                  AND LOWER(TRIM(COALESCE(p.payment_method, ''))) !~ '^on account'
                  AND LOWER(TRIM(COALESCE(p.payment_status, ''))) !~ '^on account'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM UNNEST($2::text[], $3::text[]) AS replacing(payment_id, property_name)
                    WHERE UPPER(TRIM(COALESCE(p.property_name, ''))) = UPPER(TRIM(replacing.property_name))
                      AND (
                        p.payment_id::text = replacing.payment_id
                        OR p.payment_id::text = replacing.payment_id || '-' || p.booking_reference
                      )
                  )
                GROUP BY p.booking_reference
              ) paid ON paid.booking_reference = b.booking_reference
              WHERE LOWER(TRIM(COALESCE(b.order_reference, ''))) = ANY($1::text[])
                 OR LOWER(TRIM(COALESCE(b.raw_data->>'Group', ''))) = ANY($1::text[])
              ORDER BY b.id
              FOR UPDATE OF b;
            `, [orderReferences, paymentIds, propertyNames]);

            for (const booking of groupResult.rows) {
              const references = new Set([booking.order_reference, booking.group_reference]);
              for (const reference of references) {
                const key = String(reference || '').trim().toLowerCase();
                if (!key) continue;
                if (!groupBookingsByReference.has(key)) groupBookingsByReference.set(key, []);
                groupBookingsByReference.get(key).push(booking);
              }
            }
          }

          const pendingPayments = new Map();
          for (const entry of importEntries) {
            const groupedAllocations = entry.orderRef
              ? await allocateGroupPayment(client, {
                orderReference: entry.orderRef,
                bookingReference: entry.bookingRef,
                amount: entry.amount,
                groupBookings: groupBookingsByReference.get(entry.orderRef.trim().toLowerCase()) || []
              })
              : [];
            const allocations = groupedAllocations.length
              ? groupedAllocations
              : [{ bookingReference: entry.bookingRef, roomId: entry.rawRoomId || entry.bookingRef, amount: entry.amount }];

            for (const allocation of allocations) {
              const allocationBookingReference = allocation.bookingReference || entry.bookingRef;
              const payment = {
                paymentId: entry.rawPaymentId,
                uniquePaymentKey: paymentIdentityKey(entry.rawPaymentId, allocationBookingReference, entry.orderRef),
                bookingReference: allocationBookingReference,
                orderReference: entry.orderRef,
                propertyName: entry.propertyName,
                roomId: allocation.roomId || entry.rawRoomId || entry.bookingRef,
                receivedDate: entry.paymentDate,
                amount: allocation.amount,
                currency: 'GBP',
                paymentMethod: entry.paymentMethod,
                paymentStatus: entry.paymentStatus,
                paymentDate: entry.paymentDate,
                userName: entry.userName,
                lastUpdatedDateTime: entry.lastUpdatedDateTime,
                rawData: entry.sourceData,
                sourceValues: entry.sourceValues
              };
              pendingPayments.set(
                `${payment.paymentId}\u0000${payment.bookingReference}`,
                payment
              );
            }
          }

          await deactivatePriorPaymentRows(client, paymentIdentities);

          const paymentColumns = [
            'payment_id', 'unique_payment_key', 'booking_reference', 'order_reference', 'property_name',
            'room_name', 'received_date_time', 'amount', 'currency', 'payment_method', 'payment_status',
            'payment_date', 'user_name', 'is_deleted', 'last_updated_date_time', 'raw_data',
            ...sourceMapping.map(item => `"${item.name}"`)
          ];
          const mutableColumns = [
            'unique_payment_key', 'order_reference', 'property_name', 'room_name', 'received_date_time',
            'amount', 'currency', 'payment_method', 'payment_status', 'payment_date', 'user_name',
            'is_deleted', 'last_updated_date_time', 'raw_data',
            ...sourceMapping.map(item => `"${item.name}"`)
          ];
          const paymentRows = [...pendingPayments.values()];
          const maxRowsPerBatch = Math.max(1, Math.floor(50000 / paymentColumns.length));

          for (let offset = 0; offset < paymentRows.length; offset += maxRowsPerBatch) {
            const batch = paymentRows.slice(offset, offset + maxRowsPerBatch);
            const values = [];
            const placeholders = batch.map((payment, rowIndex) => {
              const params = [
                payment.paymentId, payment.uniquePaymentKey, payment.bookingReference, payment.orderReference,
                payment.propertyName, payment.roomId, payment.receivedDate, payment.amount, payment.currency,
                payment.paymentMethod, payment.paymentStatus, payment.paymentDate, payment.userName, false,
                payment.lastUpdatedDateTime, payment.rawData, ...payment.sourceValues
              ];
              values.push(...params);
              const first = rowIndex * paymentColumns.length + 1;
              return `(${params.map((_, index) => `$${first + index}`).join(', ')})`;
            });
            const updateColumns = mutableColumns
              .map(column => `${column} = EXCLUDED.${column}`)
              .join(', ');
            await client.query(`
              INSERT INTO payments (${paymentColumns.join(', ')})
              VALUES ${placeholders.join(', ')}
              ON CONFLICT (payment_id, booking_reference) DO UPDATE SET ${updateColumns};
            `, values);
            insertedCount += batch.length;
          }

          await client.query('COMMIT');
          console.log(`✅ تم استيراد/تحديث ${insertedCount} دفعة (مع دعم Group Bookings) بنجاح.`);
          resolve(insertedCount);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`❌ خطأ أثناء معالجة مدفوعات ${groupName}:`, err.message);
          reject(err);
        } finally {
          client.release();
        }
      });
  });
}

// --- 3. المنظم الديناميكي لقراءة المجلدات المتعددة والشهور ---
async function run() {
  try {
    const rawDataDir = path.join(__dirname, '..', 'raw_data');
    const groups = ['Harbour', 'HH', 'Orlando'];

    for (const group of groups) {
      const groupDir = path.join(rawDataDir, group);
      if (!fs.existsSync(groupDir)) continue;

      const allFiles = fs.readdirSync(groupDir).filter(file => file.toLowerCase().endsWith('.csv'));

      // 1. ملفات الحجوزات
      const bookingFiles = allFiles.filter(file => !file.toLowerCase().includes('payment'));
      for (const bFile of bookingFiles) {
        await importBookings(path.join(groupDir, bFile), group);
      }

      // 2. ملفات المدفوعات
      const paymentFiles = allFiles.filter(file => file.toLowerCase().includes('payment'));
      for (const pFile of paymentFiles) {
        await importPayments(path.join(groupDir, pFile), group);
      }
    }

    console.log('\n🎉 اكتمل استيراد وتحديث كافة بيانات الفنادق والمدفوعات بنجاح!');
  } catch (err) {
    console.error('❌ حدث خطأ عام:', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    if (require.main === module) {
      await pool.end();
      if (process.exitCode !== 1) process.exitCode = 0;
    }
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  allocateGroupPayment,
  bookingFinancialsFromRow,
  deactivatePriorPaymentRows,
  findMasterPaymentRow,
  importBookings,
  importPayments,
  paymentIdentityKey,
  paymentAmountFromRow,
  run,
  shouldImportBooking
};