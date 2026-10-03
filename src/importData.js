const fs = require('fs');
const path = require('path');
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
  const cleaned = String(val).replace(/[^0-9.-]+/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0.0 : num;
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
  for (const item of mapping) await client.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS "${item.name}" TEXT`);
  return mapping;
}

function valuesForSourceColumns(row, mapping) { return mapping.map(item => row[item.header] ?? null); }

function firstSourceValue(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return row[name];
  }
  return null;
}

function paymentMethodFromRow(row, allHeaders = []) {
  return String(row['PaymentMethod'] || row['Payment Method'] || row[allHeaders[55]] || '').trim();
}

function isPlaceholderPaymentMethod(value) {
  return /see\s+(above|below)/i.test(String(value || ''));
}

function isOnAccountTransfer(row, allHeaders = []) {
  const fields = [
    paymentMethodFromRow(row, allHeaders),
    row['PaymentType'] || row['Payment Type'] || '',
    row['PaymentType2'] || row['Payment Status'] || ''
  ];
  return fields.some(value => /^on\s+account(?:\b|$)/i.test(String(value || '').trim()));
}

function paymentAmountFromRow(row, allHeaders = []) {
  return parseSafeFloat(
    row[allHeaders[74]] || row['Direct1'] || row['Total Paid'] || row['SettledAmount'] || row['OTAPrepaid1'] || row['Amount'] || 0
  );
}

function findMasterPaymentRow(entries, allHeaders = []) {
  return entries.find(entry => {
    const method = paymentMethodFromRow(entry.row, allHeaders);
    return paymentAmountFromRow(entry.row, allHeaders) !== 0
      && method
      && !isPlaceholderPaymentMethod(method)
      && !isOnAccountTransfer(entry.row, allHeaders);
  });
}

function bookingRate(booking) {
  const raw = booking?.raw_data && typeof booking.raw_data === 'object' ? booking.raw_data : {};
  return Math.max(0, parseSafeFloat(firstSourceValue(raw, [
    'Base Rate', 'BaseRate', 'base_rate', 'Revenue', 'revenue',
    'Room/Unit Revenue', 'room_unit_revenue', 'Room Rate', 'room_rate'
  ]) ?? booking?.total_revenue));
}

async function allocateGroupPayment(client, { orderReference, amount }) {
  const normalizedOrderReference = String(orderReference || '').trim();
  if (!normalizedOrderReference) return [];

  const result = await client.query(`
    SELECT booking_reference, room_unit_name, total_revenue, raw_data, id
    FROM bookings
    WHERE order_reference = $1
    ORDER BY id
    FOR UPDATE;
  `, [normalizedOrderReference]);

  const allocations = (result.rows || [])
    .map(booking => ({
      bookingReference: booking.booking_reference,
      roomId: booking.room_unit_name || booking.booking_reference,
      amountBase: bookingRate(booking)
    }))
    .filter(allocation => allocation.bookingReference && allocation.amountBase > 0);

  if (!allocations.length) return [];

  const totalBase = allocations.reduce((sum, item) => sum + Number(item.amountBase || 0), 0);
  if (!Number.isFinite(totalBase) || totalBase <= 0) {
    throw new Error(`Group payment allocation failed: invalid base total for ${normalizedOrderReference}`);
  }

  const totalCents = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(totalCents)) {
    throw new Error(`Group payment allocation failed: invalid payment amount for ${normalizedOrderReference}`);
  }

  const absoluteCents = Math.abs(totalCents);
  const shares = allocations.map((allocation, index) => {
    const exactCents = absoluteCents * Number(allocation.amountBase) / totalBase;
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

            // Keep damage-deposit/ancillary revenue independent from the core room total.
            const otherRevenue = parseSafeFloat(row['Other Revenue']);
            const totalRevenue = parseSafeFloat(row['Total Revenue']);
            const paidAmount = parseSafeFloat(row['Paid Amount']);

            if (/^cancell?ed$/i.test(bookingStatus) && totalRevenue === 0 && paidAmount === 0) {
              await client.query(`DELETE FROM bookings WHERE booking_reference = $1`, [bookingRef]);
              continue;
            }

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
            const candidateOrderRef = String(candidate['OrderReference'] ?? candidate['Order Ref.'] ?? '').trim();
            const candidatePaymentId = String(candidate['PaymentID'] ?? candidate['Payment ID'] ?? '').trim();
            const groupKey = candidateOrderRef && candidatePaymentId
              ? `${candidateOrderRef}\u0000${candidatePaymentId}`
              : `__single_${candidateIndex}`;
            if (!paymentGroups.has(groupKey)) paymentGroups.set(groupKey, []);
            paymentGroups.get(groupKey).push({ row: candidate, rowIndex: candidateIndex });
          });

          for (const [groupKey, groupRows] of paymentGroups.entries()) {
            const masterEntry = findMasterPaymentRow(groupRows, allHeaders);
            const orderReference = String(groupRows[0].row['OrderReference'] ?? groupRows[0].row['Order Ref.'] ?? '').trim();
            if (orderReference && groupRows.length > 1 && !masterEntry) continue;
            const sourceEntry = masterEntry || groupRows[0];
            const row = sourceEntry.row;
            if (isOnAccountTransfer(row, allHeaders)) continue;
            // Payment Report positions: AU = index 46, BD = index 55, BW = index 74.
            const bookingRef = String(row['BookingReference'] ?? row['Booking Reference'] ?? row[allHeaders[46]] ?? '').trim();
            const orderRef = String(row['OrderReference'] ?? row['Order Ref.'] ?? '').trim();
            const rawPaymentId = String(row['PaymentID'] ?? row['Payment ID'] ?? '').trim();
            const rawRoomId = String(row['RoomId'] ?? row['Room ID'] ?? row['Room'] ?? '').trim();
            const receivedDateValue = row['ReceivedDateTime'] ?? row['Payment Date'] ?? row['BookedDate'];
            if (!rawPaymentId || !bookingRef || !paymentDateKey(receivedDateValue)) continue;

            // اسم الفندق من عمود business_name
            const propertyName = (row['business_name'] || row['Property'] || groupName).trim();
            
            // قراءة القيمة من Direct1 أو Total Paid
            const amount = paymentAmountFromRow(row, allHeaders);
            if (!Number.isFinite(amount) || amount === 0) continue;

            const currency = 'GBP';
            const paymentMethod = paymentMethodFromRow(row, allHeaders);
            const paymentStatus = (row['PaymentType2'] || row['Payment Status'] || 'Success').trim();
            const paymentDate = parseSafeDate(row['ReceivedDateTime'] || row['Payment Date'] || row['BookedDate']);
            const userName = String(row['UserName'] || row.User || '').trim() || 'Eviivo Import';
            const lastUpdatedDateTime = parseEviivoTimestamp(row['LastUpdatedDateTime'] || row.Updated) || paymentDate;
            const allocations = orderRef && groupRows.length > 1
              ? await allocateGroupPayment(client, { orderReference: orderRef, amount })
              : [{ bookingReference: bookingRef, roomId: rawRoomId || bookingRef, amount }];
            if (!allocations.length) continue;

            const query = `
              INSERT INTO payments (
                payment_id, unique_payment_key, booking_reference, order_reference, property_name, room_name, received_date_time,
                amount, currency, payment_method, payment_status, payment_date, user_name, last_updated_date_time, raw_data,
                ${sourceMapping.map(item => `"${item.name}"`).join(', ')}
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13, $14, $15,
                ${sourceMapping.map((_, index) => `$${16 + index}`).join(', ')}
              )
              ON CONFLICT (payment_id, booking_reference) DO UPDATE SET
                booking_reference = EXCLUDED.booking_reference,
                unique_payment_key = EXCLUDED.unique_payment_key,
                order_reference = EXCLUDED.order_reference,
                property_name = EXCLUDED.property_name,
                room_name = EXCLUDED.room_name,
                received_date_time = EXCLUDED.received_date_time,
                amount = EXCLUDED.amount,
                currency = EXCLUDED.currency,
                payment_method = EXCLUDED.payment_method,
                payment_status = EXCLUDED.payment_status,
                payment_date = EXCLUDED.payment_date,
                user_name = EXCLUDED.user_name,
                is_deleted = FALSE,
                last_updated_date_time = EXCLUDED.last_updated_date_time,
                raw_data = EXCLUDED.raw_data,
                ${sourceMapping.map(item => `"${item.name}" = EXCLUDED."${item.name}"`).join(', ')};
            `;

            for (const allocation of allocations) {
              const allocationRoomId = allocation.roomId || rawRoomId;
              const allocationBookingReference = allocation.bookingReference || bookingRef;
              const uniquePaymentKey = `${rawPaymentId.length}:${rawPaymentId}:${allocationBookingReference.length}:${allocationBookingReference}`;
              if (orderRef) {
                // Remove the prior importer's per-room ID suffix before the canonical upsert.
                await client.query(`
                  DELETE FROM payments
                  WHERE payment_id = $1
                    AND booking_reference = $2;
                `, [`${rawPaymentId}-${allocationBookingReference}`, allocationBookingReference]);
              }
              const params = [
                rawPaymentId, uniquePaymentKey, allocationBookingReference, orderRef, propertyName, allocationRoomId,
                paymentDate, allocation.amount, currency, paymentMethod, paymentStatus, paymentDate,
                userName, lastUpdatedDateTime,
                JSON.stringify(Object.fromEntries(sourceHeaders.map(header => [header, row[header] ?? null]))),
                ...valuesForSourceColumns(row, sourceMapping)
              ];

              await client.query(query, params);
              insertedCount++;
            }
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

module.exports = { allocateGroupPayment, findMasterPaymentRow, importBookings, importPayments, run };