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
    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      x_id TEXT NOT NULL,
      campaign TEXT NOT NULL,
      offer TEXT NOT NULL,
      tier TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'pending',
      line_user_id TEXT,
      chosen_product TEXT,
      notes TEXT,
      shipped_at DATETIME,
      arrived_at DATETIME,
      review_due DATE,
      reviewed_at DATETIME,
      last_followup_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_winners_xid ON winners(x_id);
    CREATE INDEX IF NOT EXISTS idx_winners_line ON winners(line_user_id);
    CREATE TABLE IF NOT EXISTS knowledge_gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, gap TEXT, approval_id TEXT, resolved INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);
  // 既存DBへのカラム追加マイグレーション
  const wcols = db.prepare('PRAGMA table_info(winners)').all().map(c => c.name);
  const addCols = [['shipped_at', 'DATETIME'], ['arrived_at', 'DATETIME'], ['review_due', 'DATE'], ['reviewed_at', 'DATETIME'], ['last_followup_at', 'DATETIME']];
  for (const [name, type] of addCols) {
    if (!wcols.includes(name)) db.exec(`ALTER TABLE winners ADD COLUMN ${name} ${type}`);
  }
  const acols = db.prepare('PRAGMA table_info(approvals)').all().map(c => c.name);
  if (!acols.includes('tg_msg_id')) db.exec('ALTER TABLE approvals ADD COLUMN tg_msg_id TEXT');
  logger.info(`Database initialized at ${dbPath}`);
}
function getCustomer(userId) { return db.prepare('SELECT * FROM customers WHERE user_id = ?').get(userId); }
function upsertCustomer({ userId, displayName = null, xHandle = null, stage = null }) {
  db.prepare(`INSERT INTO customers (user_id, display_name, x_handle, stage) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      x_handle = COALESCE(excluded.x_handle, customers.x_handle),
      display_name = COALESCE(excluded.display_name, customers.display_name),
      stage = COALESCE(excluded.stage, customers.stage),
      updated_at = CURRENT_TIMESTAMP`).run(userId, displayName, xHandle, stage);
}
function getRecentConversations(userId, limit = 10) { return db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?').all(userId, limit); }
function saveConversation({ userId, direction, content }) { db.prepare('INSERT INTO conversations (user_id, direction, content) VALUES (?, ?, ?)').run(userId, direction, content); }
function saveApproval({ approvalId, userId, generatedReply, status }) { db.prepare('INSERT INTO approvals (approval_id, user_id, generated_reply, status) VALUES (?, ?, ?, ?)').run(approvalId, userId, generatedReply, status); }
// Telegramのメッセージと承認IDの対応を永続化する(Bot再起動後も返信で修正指示を受け付けられるように)
function linkTelegramMessage({ approvalId, tgMsgId }) { db.prepare('UPDATE approvals SET tg_msg_id = ? WHERE approval_id = ?').run(String(tgMsgId), approvalId); }
function findApprovalByTgMsg(tgMsgId) { return db.prepare("SELECT * FROM approvals WHERE tg_msg_id = ? AND status = 'pending'").get(String(tgMsgId)); }
function getLastIncoming(userId) { return db.prepare("SELECT content FROM conversations WHERE user_id = ? AND direction = 'incoming' ORDER BY timestamp DESC LIMIT 1").get(userId); }
function updateApproval({ approvalId, status, finalReply }) { db.prepare('UPDATE approvals SET status = ?, final_reply = ?, resolved_at = CURRENT_TIMESTAMP WHERE approval_id = ?').run(status, finalReply, approvalId); }
function findWinnerByXid(xId) { return db.prepare('SELECT * FROM winners WHERE lower(x_id) = lower(?) ORDER BY created_at DESC LIMIT 1').get(xId); }
function findWinnerByLineUser(lineUserId) { return db.prepare('SELECT * FROM winners WHERE line_user_id = ? ORDER BY created_at DESC LIMIT 1').get(lineUserId); }
function linkWinnerToLine({ winnerId, lineUserId }) {
  db.prepare(`UPDATE winners SET line_user_id = ?, status = CASE WHEN status = 'pending' THEN 'contacted' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(lineUserId, winnerId);
}
function saveKnowledgeGap({ userId, gap, approvalId }) { db.prepare('INSERT INTO knowledge_gaps (user_id, gap, approval_id) VALUES (?, ?, ?)').run(userId, gap, approvalId); }
function resolveKnowledgeGaps(userId) { db.prepare('UPDATE knowledge_gaps SET resolved = 1 WHERE user_id = ? AND resolved = 0').run(userId); }
function listKnowledgeGaps() { return db.prepare('SELECT * FROM knowledge_gaps WHERE resolved = 0 ORDER BY created_at DESC').all(); }
module.exports = { linkTelegramMessage, findApprovalByTgMsg, getLastIncoming, saveKnowledgeGap, resolveKnowledgeGaps, listKnowledgeGaps, initDb, getCustomer, upsertCustomer, getRecentConversations, saveConversation, saveApproval, updateApproval, findWinnerByXid, findWinnerByLineUser, linkWinnerToLine };
