const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function createViews() {
  try {
    const sqlPath = path.join(__dirname, 'views.sql');
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    
    console.log('⏳ جاري إنشاء وتحديث الـ SQL Views...');
    await pool.query(sql);
    console.log('✅ تم إنشاء view_financial_reconciliation و view_monthly_revenue_summary بنجاح!');
  } catch (err) {
    console.error('❌ خطأ أثناء إنشاء الـ Views:', err.message);
  } finally {
    await pool.end();
  }
}

createViews();