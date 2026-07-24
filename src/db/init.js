const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
let db = null;
function initDb() {
  const dbPath = config.db.path;
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (user_id TEXT PRIMARY KEY, display_name TEXT, x_handle TEXT, stage TEXT, path TEXT, followers INTEGER, quality TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, direction TEXT, content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, user_id TEXT, generated_reply TEXT, final_reply TEXT, status TEXT, approved_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at DATETIME);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, timestamp);
  `);
  logger.info(`Database initialized at ${dbPath}`);
}
function getCustomer(userId) { return db.prepare('SELECT * FROM customers WHERE user_id = ?').get(userId); }
function getRecentConversations(userId, limit = 10) { return db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?').all(userId, limit); }
function saveConversation({ userId, direction, content }) { db.prepare('INSERT INTO conversations (user_id, direction, content) VALUES (?, ?, ?)').run(userId, direction, content); }
function saveApproval({ approvalId, userId, generatedReply, status }) { db.prepare('INSERT INTO approvals (approval_id, user_id, generated_reply, status) VALUES (?, ?, ?, ?)').run(approvalId, userId, generatedReply, status); }
function updateApproval({ approvalId, status, finalReply }) { db.prepare('UPDATE approvals SET status = ?, final_reply = ?, resolved_at = CURRENT_TIMESTAMP WHERE approval_id = ?').run(status, finalReply, approvalId); }
module.exports = { initDb, getCustomer, getRecentConversations, saveConversation, saveApproval, updateApproval };
