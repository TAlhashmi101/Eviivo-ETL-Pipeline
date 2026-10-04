const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRES_PRISMA_URL;
const cloudConnection = Boolean(connectionString);
const supabaseConnection = /supabase\.(co|com)|pooler\.supabase\.com/i.test(connectionString || '');
let poolConnectionString = connectionString;

if (
  supabaseConnection
  && /^[a-z][a-z\d+.-]*:\/\//i.test(connectionString)
) {
  const connectionUrl = new URL(connectionString);
  const sslMode = connectionUrl.searchParams.get('sslmode');
  if (sslMode && sslMode.toLowerCase() === 'require' && !connectionUrl.searchParams.has('uselibpqcompat')) {
    connectionUrl.searchParams.set('uselibpqcompat', 'true');
    poolConnectionString = connectionUrl.toString();
  }
}

const sslRequired = process.env.PGSSLMODE
  ? process.env.PGSSLMODE !== 'disable'
  : cloudConnection && supabaseConnection;

const pool = new Pool({
  ...(poolConnectionString
    ? { connectionString: poolConnectionString }
    : {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    }),
  ...(sslRequired ? { ssl: { rejectUnauthorized: true } } : {}),
  max: process.env.VERCEL ? 3 : 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: Boolean(process.env.VERCEL)
});

module.exports = pool;