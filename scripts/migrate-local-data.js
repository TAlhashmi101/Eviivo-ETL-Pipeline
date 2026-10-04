const { Pool } = require('pg');
require('dotenv').config();

const remoteUrl = process.env.DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRES_PRISMA_URL;
if (!remoteUrl || !/supabase\.(co|com)|pooler\.supabase\.com/i.test(remoteUrl)) {
  throw new Error('Set DATABASE_URL to the linked Supabase PostgreSQL URI before migrating local data.');
}

const remotePool = require('../src/db');
const localPool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 3,
  connectionTimeoutMillis: 10_000
});

const batchSize = 200;
const tables = [
  { name: 'bookings', primaryKey: 'id', identity: ['booking_reference'], generatedId: true, comparedAmounts: ['total_revenue', 'paid_amount'] },
  { name: 'payments', primaryKey: 'id', identity: ['payment_id', 'booking_reference'], uniqueIdentity: 'unique_payment_key', generatedId: true, comparedAmounts: ['amount'] },
  { name: 'reservation_payments', primaryKey: 'payment_id', identity: ['payment_id'] },
  { name: 'reservation_charges', primaryKey: 'charge_id', identity: ['charge_id'] },
  { name: 'booking_cards', primaryKey: 'card_id', identity: ['card_id'] },
  { name: 'booking_messages', primaryKey: 'message_id', identity: ['message_id'] },
  { name: 'task_mapping_presets', primaryKey: 'preset_id', identity: ['preset_id'] },
  { name: 'petty_expenses', primaryKey: 'id', identity: ['id'] },
  { name: 'monthly_settlements', primaryKey: 'id', identity: ['id'] }
];

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function identityKey(row, columns) {
  return JSON.stringify(columns.map(column => row[column] == null ? null : String(row[column])));
}

function amountsDiffer(source, destination, columns) {
  return columns.some(column => {
    const left = source[column] == null ? null : Number(source[column]);
    const right = destination[column] == null ? null : Number(destination[column]);
    if (left == null || right == null) return left !== right;
    return !Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) >= 0.01;
  });
}

async function tableColumns(pool, tableName) {
  const result = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return result.rows;
}

async function tableCount(pool, tableName) {
  const result = await pool.query(`SELECT count(*)::bigint AS count FROM public.${quoteIdentifier(tableName)}`);
  return Number(result.rows[0].count);
}

async function identityConflicts(table, sourceRows, destinationRows) {
  const destinationKeys = new Set(destinationRows.map(row => identityKey(row, table.identity)));
  const destinationUniqueKeys = table.uniqueIdentity
    ? new Set(destinationRows.map(row => row[table.uniqueIdentity]).filter(value => value != null).map(String))
    : null;
  const destinationByIdentity = new Map(destinationRows.map(row => [identityKey(row, table.identity), row]));
  const destinationByUniqueKey = table.uniqueIdentity
    ? new Map(destinationRows.filter(row => row[table.uniqueIdentity] != null).map(row => [String(row[table.uniqueIdentity]), row]))
    : null;
  let conflicts = 0;
  let uniqueKeyOnlyConflicts = 0;
  let financialValueConflicts = 0;
  for (const source of sourceRows) {
    const key = identityKey(source, table.identity);
    const destination = destinationByIdentity.get(key);
    const uniqueConflict = destinationUniqueKeys
      && source[table.uniqueIdentity] != null
      && destinationUniqueKeys.has(String(source[table.uniqueIdentity]));
    if (!destinationKeys.has(key) && !uniqueConflict) continue;
    conflicts += 1;
    if (!destination && uniqueConflict) uniqueKeyOnlyConflicts += 1;
    const conflictingDestination = destination
      || (uniqueConflict ? destinationByUniqueKey.get(String(source[table.uniqueIdentity])) : null);
    if (conflictingDestination && table.comparedAmounts && amountsDiffer(source, conflictingDestination, table.comparedAmounts)) {
      financialValueConflicts += 1;
    }
  }
  return { conflicts, uniqueKeyOnlyConflicts, financialValueConflicts };
}

async function inspectTable(table) {
  const [sourceCount, destinationCount, sourceColumns, destinationColumns] = await Promise.all([
    tableCount(localPool, table.name),
    tableCount(remotePool, table.name),
    tableColumns(localPool, table.name),
    tableColumns(remotePool, table.name)
  ]);
  const identityColumns = [...table.identity, ...(table.uniqueIdentity ? [table.uniqueIdentity] : []), ...(table.comparedAmounts || [])];
  const selectedColumns = [...new Set(identityColumns)].map(quoteIdentifier).join(', ');
  const [sourceRows, destinationRows] = await Promise.all([
    localPool.query(`SELECT ${selectedColumns} FROM public.${quoteIdentifier(table.name)}`),
    remotePool.query(`SELECT ${selectedColumns} FROM public.${quoteIdentifier(table.name)}`)
  ]);
  const conflicts = await identityConflicts(table, sourceRows.rows, destinationRows.rows);
  const destinationColumnNames = new Set(destinationColumns.map(column => column.column_name));
  return {
    ...table,
    sourceCount,
    destinationCount,
    sourceColumns,
    destinationColumns,
    missingRemoteColumns: sourceColumns
      .filter(column => !destinationColumnNames.has(column.column_name))
      .map(column => column.column_name),
    ...conflicts
  };
}

async function ensureColumns(client, table, sourceColumns, destinationColumns) {
  const existing = new Set(destinationColumns.map(column => column.column_name));
  const addable = table.name === 'bookings' || table.name === 'payments';
  for (const column of sourceColumns) {
    if (existing.has(column.column_name)) continue;
    if (!addable || column.data_type !== 'text') {
      throw new Error(`Cannot safely copy ${table.name}.${column.column_name}: the remote column is missing and is not a dynamic TEXT field.`);
    }
    await client.query(
      `ALTER TABLE public.${quoteIdentifier(table.name)} ADD COLUMN ${quoteIdentifier(column.column_name)} TEXT`
    );
    existing.add(column.column_name);
  }
}

async function copyTable(table, overwritePaymentConflicts) {
  const client = await remotePool.connect();
  let written = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    const [sourceColumns, destinationColumns] = await Promise.all([
      tableColumns(localPool, table.name),
      tableColumns(client, table.name)
    ]);
    await ensureColumns(client, table, sourceColumns, destinationColumns);
    const destinationColumnNames = new Set((await tableColumns(client, table.name)).map(column => column.column_name));
    const columns = sourceColumns
      .map(column => column.column_name)
      .filter(column => destinationColumnNames.has(column) && !(table.generatedId && column === table.primaryKey));
    if (!sourceColumns.some(column => column.column_name === table.primaryKey)) {
      throw new Error(`Primary key ${table.name}.${table.primaryKey} is missing from the local source.`);
    }
    const selectedColumns = sourceColumns.map(column => quoteIdentifier(column.column_name)).join(', ');
    const insertColumns = columns.map(quoteIdentifier).join(', ');
    const identityColumns = [...table.identity, ...(table.uniqueIdentity ? [table.uniqueIdentity] : [])];
    const existingResult = await client.query(
      `SELECT ${identityColumns.map(quoteIdentifier).join(', ')} FROM public.${quoteIdentifier(table.name)}`
    );
    const existingIdentities = new Set(existingResult.rows.map(row => identityKey(row, table.identity)));
    let lastId = 0;

    while (true) {
      const batch = await localPool.query(
        `SELECT ${selectedColumns} FROM public.${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(table.primaryKey)} > $1 ORDER BY ${quoteIdentifier(table.primaryKey)} LIMIT $2`,
        [lastId, batchSize]
      );
      if (!batch.rows.length) break;

      const upsertPayments = table.name === 'payments' && overwritePaymentConflicts;
      const candidates = upsertPayments
        ? batch.rows
        : batch.rows.filter(row => !existingIdentities.has(identityKey(row, table.identity)));
      skipped += batch.rows.length - candidates.length;
      if (!candidates.length) {
        lastId = batch.rows[batch.rows.length - 1][table.primaryKey];
        continue;
      }

      const values = [];
      const jsonColumns = new Set(sourceColumns
        .filter(column => column.data_type === 'json' || column.data_type === 'jsonb')
        .map(column => column.column_name));
      const placeholders = candidates.map((row, rowIndex) => {
        const rowPlaceholders = columns.map((column, columnIndex) => {
          values.push(row[column] == null || !jsonColumns.has(column) ? row[column] : JSON.stringify(row[column]));
          return `$${rowIndex * columns.length + columnIndex + 1}`;
        });
        return `(${rowPlaceholders.join(', ')})`;
      });
      const paymentUpdates = upsertPayments
        ? columns
          .filter(column => !table.identity.includes(column))
          .map(column => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
        : [];
      const paymentUpdatePredicate = paymentUpdates.length
        ? ` WHERE ${columns
          .filter(column => !table.identity.includes(column))
          .map(column => `payments.${quoteIdentifier(column)} IS DISTINCT FROM EXCLUDED.${quoteIdentifier(column)}`)
          .join(' OR ')}`
        : '';
      const conflictAction = paymentUpdates.length
        ? `ON CONFLICT (${table.identity.map(quoteIdentifier).join(', ')}) DO UPDATE SET ${paymentUpdates.join(', ')}${paymentUpdatePredicate}`
        : 'ON CONFLICT DO NOTHING';
      const result = await client.query(
        `INSERT INTO public.${quoteIdentifier(table.name)} (${insertColumns}) VALUES ${placeholders.join(', ')} ${conflictAction} RETURNING 1`,
        values
      );
      written += result.rowCount;
      skipped += candidates.length - result.rowCount;
      for (const row of candidates) existingIdentities.add(identityKey(row, table.identity));
      lastId = batch.rows[batch.rows.length - 1][table.primaryKey];
    }

    await client.query(`
      SELECT setval(
        pg_get_serial_sequence($1, $2),
        COALESCE(MAX(${quoteIdentifier(table.primaryKey)}), 1),
        MAX(${quoteIdentifier(table.primaryKey)}) IS NOT NULL
      )
      FROM public.${quoteIdentifier(table.name)}
    `, [`public.${table.name}`, table.primaryKey]);

    await client.query('COMMIT');
    return { written, skipped };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const overwritePaymentConflicts = process.argv.includes('--overwrite-payment-conflicts');
  const localTables = await localPool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  const knownTables = new Set(tables.map(table => table.name));
  const unknownTableNames = localTables.rows.map(row => row.tablename).filter(name => !knownTables.has(name));
  const unmappedTables = [];
  for (const tableName of unknownTableNames) {
    if (await tableCount(localPool, tableName)) unmappedTables.push(tableName);
  }
  if (unmappedTables.length) {
    throw new Error(`Unmapped local tables contain data: ${unmappedTables.join(', ')}`);
  }

  const inspections = [];
  for (const table of tables) inspections.push(await inspectTable(table));

  console.log(JSON.stringify(inspections.map(table => ({
    table: table.name,
    localRows: table.sourceCount,
    remoteRowsBefore: table.destinationCount,
    missingRemoteColumns: table.missingRemoteColumns,
    identityConflicts: table.conflicts,
    uniqueKeyOnlyConflicts: table.uniqueKeyOnlyConflicts,
    financialValueConflicts: table.financialValueConflicts,
    estimatedNewRows: table.sourceCount - table.conflicts
  }))));

  if (!apply) {
    console.log('Dry run only; pass --apply to copy rows. Existing remote identities are preserved on conflict.');
    return;
  }

  const uniqueKeyConflicts = inspections.filter(table => table.uniqueKeyOnlyConflicts > 0);
  if (uniqueKeyConflicts.length) {
    throw new Error(`Unique keys collide with different natural identities in ${uniqueKeyConflicts.map(table => table.name).join(', ')}. Resolve those conflicts before applying.`);
  }
  const financialConflicts = inspections.filter(table => table.financialValueConflicts > 0);
  if (financialConflicts.length && !overwritePaymentConflicts) {
    throw new Error(`Financial values differ for existing remote identities in ${financialConflicts.map(table => table.name).join(', ')}. Review the conflicts or pass --overwrite-payment-conflicts to make local payment rows authoritative.`);
  }

  for (const table of inspections) {
    const result = await copyTable(table, overwritePaymentConflicts);
    console.log(`${table.name}: written=${result.written}, skipped=${result.skipped}`);
  }
}

main()
  .catch(error => {
    console.error('Local-to-Supabase data migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([localPool.end(), remotePool.end()]);
  });
