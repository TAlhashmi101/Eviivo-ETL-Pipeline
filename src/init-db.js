const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function initDB() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await pool.query(sql);
    console.log('✅ تم إنشاء الجداول بنجاح في قاعدة البيانات!');
  } catch (err) {
    console.error('❌ حدث خطأ أثناء إنشاء الجداول:', err);
  } finally {
    await pool.end();
  }
}

initDB();