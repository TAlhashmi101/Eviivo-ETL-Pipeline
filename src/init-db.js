const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function initDB() {
  const migrationDirectory = path.join(__dirname, '..', 'supabase', 'migrations');
  const migrations = fs.readdirSync(migrationDirectory)
    .filter(file => /^\d+.*\.sql$/.test(file))
    .sort();

  if (!migrations.length) {
    throw new Error(`No SQL migrations found in ${migrationDirectory}.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const migration of migrations) {
      const sql = fs.readFileSync(path.join(migrationDirectory, migration), 'utf-8');
      await client.query(sql);
      console.log(`Applied ${migration}`);
    }
    await client.query('COMMIT');
    console.log('Database migrations applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

initDB().catch(error => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});