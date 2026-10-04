const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allocateGroupPayment,
  bookingFinancialsFromRow,
  deactivatePriorPaymentRows,
  paymentAmountFromRow,
  paymentIdentityKey,
  shouldImportBooking
} = require('../src/importData');

test('unpaid other revenue is excluded from expected booking revenue', () => {
  assert.deepEqual(
    bookingFinancialsFromRow({
      'Total Revenue': '£25.00',
      'Room/Unit Revenue': '£20.00',
      'Other Revenue': '£5.00',
      'Paid Amount': '£0.00'
    }),
    { roomRevenue: 20, otherRevenue: 5, totalRevenue: 20, paidAmount: 0 }
  );
});

test('only the other-revenue portion supported by Paid Amount is included', () => {
  const booking = paidAmount => bookingFinancialsFromRow({
    'Total Revenue': '£122.49',
    'Room/Unit Revenue': '£22.49',
    'Other Revenue': '£100.00',
    'Paid Amount': `£${paidAmount}`
  });

  assert.equal(booking('22.49').totalRevenue, 22.49);
  assert.equal(booking('50.00').totalRevenue, 50);
  assert.equal(booking('122.49').totalRevenue, 122.49);
});

test('paid-deposit calculations use report revenue when room revenue is missing', () => {
  assert.equal(bookingFinancialsFromRow({
    'Total Revenue': '£122.49',
    'Room/Unit Revenue': '£0.00',
    'Other Revenue': '£100.00',
    'Paid Amount': '£22.49'
  }).totalRevenue, 22.49);
});

test('paid other revenue is included when Eviivo total revenue excludes the deposit', () => {
  assert.equal(bookingFinancialsFromRow({
    'Total Revenue': '£22.49',
    'Room/Unit Revenue': '£22.49',
    'Other Revenue': '£100.00',
    'Paid Amount': '£122.49'
  }).totalRevenue, 122.49);
});

test('booking ingestion drops unsupported shells but retains paid cancellations', () => {
  assert.equal(shouldImportBooking('Confirmed', 0, 0), false);
  assert.equal(shouldImportBooking('Confirmed', 100, 0), true);
  assert.equal(shouldImportBooking('Canceled', 100, 0), false);
  assert.equal(shouldImportBooking('Cancelled', 0, 1), true);
});

test('payment amount lookup skips a zero Direct1 when another amount column is populated', () => {
  assert.equal(
    paymentAmountFromRow({ Direct1: '0.00', OTAPrepaid1: '12.34' }, ['Direct1', 'OTAPrepaid1']),
    12.34
  );
});

test('payment amount lookup preserves the Eviivo Direct1 amount', () => {
  assert.equal(
    paymentAmountFromRow({ Direct1: '£ 362.95' }, ['Direct1']),
    362.95
  );
});

test('payment replacement retires prior allocations for the same report payment and property', async () => {
  const queries = [];
  const client = {
    query: async (...args) => {
      queries.push(args);
      return { rowCount: 2 };
    }
  };

  await deactivatePriorPaymentRows(client, [
    { paymentId: '47092968', propertyName: 'Wembar Hotel' },
    { paymentId: '47092968', propertyName: 'Wembar Hotel' }
  ]);

  assert.equal(queries.length, 1);
  assert.match(queries[0][0], /UPDATE payments\s+SET is_deleted = TRUE/);
  assert.match(queries[0][0], /UNNEST\(\$1::text\[\], \$2::text\[\]\)/);
  assert.match(queries[0][0], /is_deleted = FALSE/);
  assert.deepEqual(queries[0][1], [['47092968'], ['Wembar Hotel']]);
});

test('group payments are allocated by positive booking revenue and exclude empty shells', async () => {
  const client = {
    query: async () => ({
      rows: [
        { booking_reference: 'ROOM-1', room_unit_name: 'Room 1', total_revenue: 120, other_revenue: 100, raw_data: { 'Total Revenue': '120', 'Room/Unit Revenue': '20', 'Other Revenue': '100', 'Paid Amount': '20' }, booking_status: 'Confirmed', paid_amount: 20, actual_paid_amount: 0 },
        { booking_reference: 'ROOM-2', room_unit_name: 'Room 2', total_revenue: 140, other_revenue: 100, raw_data: { 'Total Revenue': '140', 'Room/Unit Revenue': '40', 'Other Revenue': '100', 'Paid Amount': '40' }, booking_status: 'Confirmed', paid_amount: 40, actual_paid_amount: 0 },
        { booking_reference: 'SHELL', room_unit_name: 'Empty shell', total_revenue: 0, other_revenue: 0, raw_data: {}, booking_status: 'Confirmed', paid_amount: 0, actual_paid_amount: 0 },
        { booking_reference: 'CANCELLED', room_unit_name: 'Cancelled', total_revenue: 20, other_revenue: 0, raw_data: {}, booking_status: 'Canceled', paid_amount: 0, actual_paid_amount: 0 }
      ]
    })
  };

  const allocations = await allocateGroupPayment(client, { orderReference: 'ORDER-1', amount: 60 });
  assert.deepEqual(allocations, [
    { bookingReference: 'ROOM-1', roomId: 'Room 1', amount: 20 },
    { bookingReference: 'ROOM-2', roomId: 'Room 2', amount: 40 }
  ]);
  assert.equal(allocations.reduce((total, allocation) => total + allocation.amount, 0), 60);
});

test('fully paid booking-specific payments are not diluted across the shared order', async () => {
  const client = {
    query: async () => ({
      rows: [
        {
          booking_reference: '355-998-922',
          room_unit_name: 'Room 07 - 1st F',
          total_revenue: 362.95,
          other_revenue: 0,
          raw_data: {
            'Total Revenue': '£362.95',
            'Room/Unit Revenue': '£362.95',
            'Paid Amount': '£362.95'
          },
          booking_status: 'Confirmed',
          paid_amount: 362.95,
          actual_paid_amount: 0
        },
        {
          booking_reference: 'ANOTHER-ROOM',
          room_unit_name: 'Room 08',
          total_revenue: 100,
          other_revenue: 0,
          raw_data: { 'Total Revenue': '£100.00', 'Room/Unit Revenue': '£100.00' },
          booking_status: 'Confirmed',
          paid_amount: 0,
          actual_paid_amount: 0
        }
      ]
    })
  };

  assert.deepEqual(
    await allocateGroupPayment(client, {
      orderReference: 'ATN-785-667',
      bookingReference: '355-998-922',
      amount: 362.95
    }),
    [{ bookingReference: '355-998-922', roomId: 'Room 07 - 1st F', amount: 362.95 }]
  );
});

test('preloaded order bookings keep a fully paid booking payment at its source amount', async () => {
  const client = {
    query: async () => {
      throw new Error('Preloaded group data should avoid another database query.');
    }
  };

  const allocations = await allocateGroupPayment(client, {
    orderReference: 'ATN-785-667',
    bookingReference: '355-998-922',
    amount: 362.95,
    groupBookings: [
      {
        booking_reference: '355-998-922',
        room_unit_name: 'Room 07',
        total_revenue: 362.95,
        raw_data: {
          'Total Revenue': '362.95',
          'Room/Unit Revenue': '362.95',
          'Paid Amount': '362.95'
        },
        booking_status: 'Confirmed',
        paid_amount: 362.95,
        actual_paid_amount: 0
      },
      {
        booking_reference: 'OTHER-ROOM',
        room_unit_name: 'Room 08',
        total_revenue: 100,
        raw_data: { 'Total Revenue': '100', 'Room/Unit Revenue': '100' },
        booking_status: 'Confirmed',
        paid_amount: 0,
        actual_paid_amount: 0
      }
    ]
  });

  assert.deepEqual(allocations, [
    { bookingReference: '355-998-922', roomId: 'Room 07', amount: 362.95 }
  ]);
});

test('group allocation preserves penny totals for refunds and uses bounded payment keys', async () => {
  const client = {
    query: async () => ({
      rows: [
        { booking_reference: 'A', total_revenue: 0, other_revenue: 0, raw_data: {}, booking_status: 'Confirmed', paid_amount: 1, actual_paid_amount: 0 },
        { booking_reference: 'B', total_revenue: 0, other_revenue: 0, raw_data: {}, booking_status: 'Confirmed', paid_amount: 1, actual_paid_amount: 0 },
        { booking_reference: 'C', total_revenue: 0, other_revenue: 0, raw_data: {}, booking_status: 'Confirmed', paid_amount: 1, actual_paid_amount: 0 }
      ]
    })
  };
  const allocations = await allocateGroupPayment(client, { orderReference: 'ORDER-2', amount: -0.01 });
  assert.equal(allocations.reduce((total, allocation) => total + allocation.amount, 0), -0.01);
  assert.equal(allocations.filter(allocation => allocation.amount !== 0).length, 1);
  assert.equal(paymentIdentityKey('P'.repeat(100), 'B'.repeat(100), 'O'.repeat(100)).length, 64);
});
