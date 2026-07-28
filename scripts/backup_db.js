#!/usr/bin/env node
// customers.db の日次バックアップ(7世代保持)
// launchd (com.user.line.dbbackup) から毎日3:30に実行される
require('dotenv').config();
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const dbPath = process.env.DB_PATH || './data/customers.db';
const backupDir = './data/backups';
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const dest = path.join(backupDir, `customers-${stamp}.db`);
const db = new Database(dbPath, { readonly: true });
db.backup(dest).then(() => {
  console.log(new Date().toISOString(), 'backup done:', dest);
  const files = fs.readdirSync(backupDir).filter(f => /^customers-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  while (files.length > 7) {
    const old = files.shift();
    fs.unlinkSync(path.join(backupDir, old));
    console.log('pruned:', old);
  }
  process.exit(0);
}).catch(e => { console.error('backup failed:', e.message); process.exit(1); });
