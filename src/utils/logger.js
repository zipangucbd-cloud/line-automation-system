const fs = require('fs');
const path = require('path');
const logDir = './data/logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
// 書き込みのたびに日付を評価する(起動時に固定すると日付が変わってもファイルが切り替わらず、
// 日次レポートのログ由来チェックが無言で効かなくなる: 2026-09-15の障害で発覚)
const logFile = () => path.join(logDir, `app-${new Date().toISOString().split('T')[0]}.log`);
function log(level, ...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  const line = `[${timestamp}] [${level}] ${message}\n`;
  console.log(line.trim());
  fs.appendFileSync(logFile(), line);
}
module.exports = {
  info: (...args) => log('INFO', ...args),
  warn: (...args) => log('WARN', ...args),
  error: (...args) => log('ERROR', ...args),
  debug: (...args) => log('DEBUG', ...args),
};
