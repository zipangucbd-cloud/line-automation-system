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
  // 後半5列は投稿を見た人間の判断。スプレッドシートで蓄積してきた分析資産をBot側でも引き継ぐため。
  const addCols = [['shipped_at', 'DATETIME'], ['arrived_at', 'DATETIME'], ['review_due', 'DATE'], ['reviewed_at', 'DATETIME'], ['last_followup_at', 'DATETIME'],
    ['eval', 'TEXT'], ['impressions', 'TEXT'], ['genre', 'TEXT'], ['face', 'TEXT'], ['shadowban', 'TEXT'], ['followers', 'TEXT'], ['eval_note', 'TEXT']];
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
// Telegramから登録された当選者を追加する。同じIDの未完了案件があれば重複として知らせる。
function addWinner({ xId, campaign, offer, tier = 'normal', notes = null }) {
  const id = String(xId).replace(/^@/, '').trim();
  const dup = db.prepare("SELECT id, campaign FROM winners WHERE lower(x_id) = lower(?) AND status NOT IN ('done','cancelled')").get(id);
  const r = db.prepare('INSERT INTO winners (x_id, campaign, offer, tier, notes) VALUES (?, ?, ?, ?, ?)').run(id, campaign, offer, tier, notes);
  return { id: r.lastInsertRowid, duplicate: dup || null };
}
function listActiveWinners(limit = 50) {
  return db.prepare("SELECT id, x_id, campaign, offer, tier, status, line_user_id FROM winners WHERE status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT ?").all(limit);
}
// 当選者の進捗サマリ。件数が増えても読める形にするため、生の一覧ではなく状況別に集計する。
function winnerDashboard({ campaign = null, stalledDays = 7 } = {}) {
  const where = campaign ? "AND w.campaign LIKE '%' || ? || '%'" : '';
  const params = campaign ? [campaign] : [];
  const rows = db.prepare(`
    SELECT w.id, w.x_id, w.campaign, w.offer, w.tier, w.status, w.line_user_id, w.updated_at,
           c.stage AS stage, c.display_name AS display_name,
           CAST(julianday('now') - julianday(COALESCE(c.updated_at, w.updated_at)) AS INTEGER) AS idle_days
    FROM winners w LEFT JOIN customers c ON c.user_id = w.line_user_id
    WHERE w.status NOT IN ('done','cancelled') ${where}
    ORDER BY idle_days DESC`).all(...params);
  const groups = {};
  for (const r of rows) {
    const key = !r.line_user_id ? 'LINE未接続' : (r.stage || 'ステージ未判定');
    (groups[key] = groups[key] || []).push(r);
  }
  const stalled = rows.filter((r) => r.idle_days >= stalledDays);
  const campaigns = {};
  for (const r of rows) campaigns[r.campaign] = (campaigns[r.campaign] || 0) + 1;
  return { total: rows.length, groups, stalled, campaigns, rows };
}
// 完了ステージに到達した当選者を自動的にdoneにする(一覧が無限に伸びないように)
function autoCompleteWinners() {
  const r = db.prepare(`
    UPDATE winners SET status = 'done', updated_at = CURRENT_TIMESTAMP
    WHERE status NOT IN ('done','cancelled') AND line_user_id IN (
      SELECT user_id FROM customers WHERE stage IN ('完了','S9_キャッシュバック済','S9_連鎖案内済'))`).run();
  return r.changes;
}
function completeWinnerByXid(xId) {
  const r = db.prepare("UPDATE winners SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE lower(x_id) = lower(?) AND status NOT IN ('done','cancelled')").run(String(xId).replace(/^@/, ''));
  return r.changes;
}
function findWinnerByXid(xId) { return db.prepare('SELECT * FROM winners WHERE lower(x_id) = lower(?) ORDER BY created_at DESC LIMIT 1').get(xId); }
function findWinnerByLineUser(lineUserId) { return db.prepare('SELECT * FROM winners WHERE line_user_id = ? ORDER BY created_at DESC LIMIT 1').get(lineUserId); }
// 会話から確定した進捗イベントを当選者レコードに反映する。
// 既に記録済みの項目は上書きしない(会話で何度も話題に出るため、最初の確定日を残す)。
function applyWinnerEvents({ lineUserId, events }) {
  if (!lineUserId || !events) return null;
  const w = db.prepare("SELECT * FROM winners WHERE line_user_id = ? AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1").get(lineUserId);
  if (!w) return null;
  const applied = [];
  if (events.shipped && !w.shipped_at) {
    db.prepare("UPDATE winners SET shipped_at = CURRENT_TIMESTAMP, status = 'shipped', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(w.id);
    applied.push('発送日');
  }
  if (events.arrived && !w.arrived_at) {
    db.prepare("UPDATE winners SET arrived_at = CURRENT_TIMESTAMP, status = 'arrived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(w.id);
    applied.push('到着日');
  }
  if (events.reviewed && !w.reviewed_at) {
    db.prepare("UPDATE winners SET reviewed_at = CURRENT_TIMESTAMP, status = 'reviewed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(w.id);
    applied.push('レビュー完了');
  }
  if (typeof events.review_due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(events.review_due)) {
    db.prepare('UPDATE winners SET review_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(events.review_due, w.id);
    applied.push(`レビュー予定日=${events.review_due}`);
  }
  if (typeof events.product === 'string' && ['gummy', 'cream'].includes(events.product) && !w.chosen_product) {
    db.prepare('UPDATE winners SET chosen_product = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(events.product, w.id);
    applied.push(`選択商品=${events.product}`);
  }
  return applied.length ? { xId: w.x_id, applied } : null;
}
// 投稿を見た人間の判断(評価・インプ数・ジャンル等)を記録する。
// スプレッドシートに手入力していた分析項目を、レビュー完了の場でTelegramから受け取る。
function saveWinnerEvaluation({ winnerId, fields }) {
  const allow = ['eval', 'impressions', 'genre', 'face', 'shadowban', 'followers', 'eval_note'];
  const sets = [], vals = [];
  for (const k of allow) {
    if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') { sets.push(`${k} = ?`); vals.push(String(fields[k])); }
  }
  if (!sets.length) return null;
  vals.push(winnerId);
  db.prepare(`UPDATE winners SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);
  return db.prepare('SELECT * FROM winners WHERE id = ?').get(winnerId);
}
function getWinnerByLineUser(lineUserId) {
  return db.prepare("SELECT * FROM winners WHERE line_user_id = ? ORDER BY created_at DESC LIMIT 1").get(lineUserId);
}
// レビュー実績のある当選者(実績マスターへ合流させる対象)
function listReviewedWinners() {
  return db.prepare("SELECT * FROM winners WHERE reviewed_at IS NOT NULL OR eval IS NOT NULL").all();
}
function linkWinnerToLine({ winnerId, lineUserId }) {
  db.prepare(`UPDATE winners SET line_user_id = ?, status = CASE WHEN status = 'pending' THEN 'contacted' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(lineUserId, winnerId);
}
function saveKnowledgeGap({ userId, gap, approvalId }) { db.prepare('INSERT INTO knowledge_gaps (user_id, gap, approval_id) VALUES (?, ?, ?)').run(userId, gap, approvalId); }
function resolveKnowledgeGaps(userId) { db.prepare('UPDATE knowledge_gaps SET resolved = 1 WHERE user_id = ? AND resolved = 0').run(userId); }
function listKnowledgeGaps() { return db.prepare('SELECT * FROM knowledge_gaps WHERE resolved = 0 ORDER BY created_at DESC').all(); }
// 整合性チェック用: 直近12時間で「最後の受信の後に送信が無い」ユーザーを列挙する
function listUnansweredUsers() {
  return db.prepare(`
    SELECT user_id,
           MAX(CASE WHEN direction='incoming' THEN id ELSE 0 END) AS last_in,
           MAX(CASE WHEN direction='outgoing' THEN id ELSE 0 END) AS last_out,
           MAX(CASE WHEN direction='incoming' THEN timestamp END) AS last_in_at
    FROM conversations
    WHERE timestamp >= datetime('now','-12 hours')
    GROUP BY user_id`).all().filter((r) => r.last_in > r.last_out);
}

// 再起動後の再発行用: 直近days日のpendingカードを列挙する
function listPendingApprovals(days = 3) {
  return db.prepare(`SELECT approval_id, user_id, generated_reply, created_at, tg_msg_id FROM approvals WHERE status = 'pending' AND created_at >= datetime('now', ?)`).all(`-${days} days`);
}

module.exports = { listPendingApprovals, listUnansweredUsers, saveWinnerEvaluation, getWinnerByLineUser, listReviewedWinners, applyWinnerEvents, addWinner, listActiveWinners, winnerDashboard, autoCompleteWinners, completeWinnerByXid, linkTelegramMessage, findApprovalByTgMsg, getLastIncoming, saveKnowledgeGap, resolveKnowledgeGaps, listKnowledgeGaps, initDb, getCustomer, upsertCustomer, getRecentConversations, saveConversation, saveApproval, updateApproval, findWinnerByXid, findWinnerByLineUser, linkWinnerToLine };
