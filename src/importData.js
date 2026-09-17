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
                booking_status = EXCLUDED.booking_status,
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
          const sourceMapping = await ensureSourceColumns(client, 'payments', sourceHeaders, new Set(['id', 'payment_id', 'unique_payment_key', 'booking_reference', 'order_reference', 'received_date_time', 'guest_name', 'business_name', 'room_name', 'channel', 'channel_reference', 'payment_type', 'payment_method', 'property_name', 'currency', 'payment_status', 'payment_date', 'amount', 'created_at', 'raw_data']));

          for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const row = rows[rowIndex];
            // Payment Report positions: AU = index 46, BD = index 55, BW = index 74.
            const bookingRef = String(row['BookingReference'] ?? row['Booking Reference'] ?? row[allHeaders[46]] ?? '').trim();
            const orderRef = String(row['OrderReference'] ?? row['Order Ref.'] ?? '').trim();
            const paymentIdValue = row['PaymentID'] ?? row['Payment ID'] ?? `PAYMENT-${bookingRef}-${rowIndex + 1}`;
            const rawPaymentId = String(paymentIdValue).trim();
            const rawRoomId = String(row['RoomId'] ?? row['Room ID'] ?? row['Room'] ?? '').trim();
            const receivedDateValue = row['ReceivedDateTime'] ?? row['Payment Date'] ?? row['BookedDate'];
            const uniquePaymentKey = `${paymentDateKey(receivedDateValue)}_${rawPaymentId}_${bookingRef}_${rawRoomId}`;

            if (!rawPaymentId || !bookingRef || !rawRoomId || !paymentDateKey(receivedDateValue)) continue;

            // اسم الفندق من عمود business_name
            const propertyName = (row['business_name'] || row['Property'] || groupName).trim();
            
            // قراءة القيمة من Direct1 أو Total Paid
            const amount = parseSafeFloat(
              row[allHeaders[74]] ||
              row['Direct1'] || 
              row['Total Paid'] || 
              row['SettledAmount'] || 
              row['OTAPrepaid1'] || 
              row['Amount'] || 
              0
            );

            const currency = 'GBP';
            const paymentMethod = String(row['PaymentMethod'] || row['Payment Method'] || row[allHeaders[55]] || '').trim();
            const paymentStatus = (row['PaymentType2'] || row['Payment Status'] || 'Success').trim();
            const paymentDate = parseSafeDate(row['ReceivedDateTime'] || row['Payment Date'] || row['BookedDate']);

            const query = `
              INSERT INTO payments (
                payment_id, unique_payment_key, booking_reference, order_reference, property_name, received_date_time,
                amount, currency, payment_method, payment_status, payment_date, raw_data,
                ${sourceMapping.map(item => `"${item.name}"`).join(', ')}
              ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12,
                ${sourceMapping.map((_, index) => `$${13 + index}`).join(', ')}
              )
              ON CONFLICT (unique_payment_key) DO UPDATE SET
                payment_id = EXCLUDED.payment_id,
                booking_reference = EXCLUDED.booking_reference,
                order_reference = EXCLUDED.order_reference,
                property_name = EXCLUDED.property_name,
                received_date_time = EXCLUDED.received_date_time,
                amount = EXCLUDED.amount,
                currency = EXCLUDED.currency,
                payment_method = EXCLUDED.payment_method,
                payment_status = EXCLUDED.payment_status,
                payment_date = EXCLUDED.payment_date,
                raw_data = EXCLUDED.raw_data,
                ${sourceMapping.map(item => `"${item.name}" = EXCLUDED."${item.name}"`).join(', ')};
            `;

            const params = [
              rawPaymentId, uniquePaymentKey, bookingRef, orderRef, propertyName,
              paymentDate, amount, currency, paymentMethod, paymentStatus, paymentDate,
              JSON.stringify(Object.fromEntries(sourceHeaders.map(header => [header, row[header] ?? null]))),
              ...valuesForSourceColumns(row, sourceMapping)
            ];

            await client.query(query, params);
            insertedCount++;
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

module.exports = { importBookings, importPayments, run };