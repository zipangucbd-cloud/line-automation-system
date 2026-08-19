// data/negative_reviewers.json(reviewer_syncが週次で自動生成)との照合ヘルパー。
// 過去に「良くない」評価を付けた人が誤って再当選していないかを、
// 当選者登録(add_winner / Telegramの/当選者)とLINE照合の時点で検知して警告する。
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '../../data/negative_reviewers.json');

function negativeInfo(xId) {
  try {
    const { negatives } = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return negatives[String(xId || '').replace(/^@/, '').trim().toLowerCase()] || null;
  } catch (_) {
    return null; // リスト未生成・読込失敗でも登録機能そのものは止めない
  }
}

const PROV_FILE = path.join(__dirname, '../../data/sheet_provisions.json');

// スプシ台帳(ギフティング/ギフ回数)ベースの提供履歴。被り選出の検知に使う
function provisionInfo(xId) {
  try {
    const { people } = JSON.parse(fs.readFileSync(PROV_FILE, 'utf-8'));
    return people[String(xId || '').replace(/^@/, '').trim().toLowerCase()] || null;
  } catch (_) {
    return null;
  }
}

module.exports = { negativeInfo, provisionInfo };
