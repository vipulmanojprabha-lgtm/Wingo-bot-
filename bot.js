const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ==========================================
// 1. CONFIGURATION
// ==========================================
const BOT_TOKEN = '9105400057:AAHyiNMG8JWIoPbXyxzHYsHeLUkXDRegif8';
let CHANNEL_ID = null; // Auto-detect ho jayegi jab aap channel me post karenge
const GAME_MODE = '30sec'; // '30sec' ya '1min'

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// WinGo API endpoints (from your HTML engine)
const API_ENDPOINTS = {
  '1min': [
    'https://draw.ar-lottery02.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
    'https://draw.ar-lottery03.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
    'https://draw.ar-lottery04.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
    'https://draw.ar-lottery05.com/WinGo/WinGo_1M/GetHistoryIssuePage.json'
  ],
  '30sec': [
    'https://draw.ar-lottery02.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
    'https://draw.ar-lottery03.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
    'https://draw.ar-lottery04.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
    'https://draw.ar-lottery05.com/WinGo/WinGo_30S/GetHistoryIssuePage.json'
  ]
};

// ==========================================
// AUTO-DETECT CHANNEL ID
// ==========================================
bot.on('channel_post', (msg) => {
  if (!CHANNEL_ID) {
    CHANNEL_ID = msg.chat.id;
    console.log(`✅ Channel successfully detected! Chat ID: ${CHANNEL_ID}`);
    bot.sendMessage(CHANNEL_ID, '🚀 *SPIDER BOT CONNECTED SUCCESSFULLY!* Signals will start now.', { parse_mode: 'Markdown' });
  }
});

// ==========================================
// 2. ROOT DIGIT PREDICTION ENGINE
// ==========================================
const REQUIRED_RESULTS = 5;
const REVERSE_LEVELS = [2, 3]; // L2 aur L3 par signal reverse hoga

let currentLevel = 1;
let pendingPrediction = null; 
let lastProcessedIssue = null;
let busy = false;

function reduceToRootDigit(total) {
  let value = Math.abs(Math.trunc(total));
  while (value > 9) {
    let sum = 0;
    const str = String(value);
    for (let i = 0; i < str.length; i++) sum += Number(str[i]);
    value = sum;
  }
  return value;
}

function computePredictionDetails(numbers) {
  if (!Array.isArray(numbers) || numbers.length < REQUIRED_RESULTS) return null;
  const five = numbers.slice(0, REQUIRED_RESULTS).map(Number);
  if (five.some(n => !Number.isFinite(n))) return null;

  const sum = five.reduce((a, b) => a + b, 0);
  const rootDigit = reduceToRootDigit(sum);
  const prediction = rootDigit >= 5 ? 'BIG' : 'SMALL';

  return { numbers: five, sum, rootDigit, prediction };
}

function lg_nextIssueId(issue) {
  const match = String(issue || '').match(/^(.*?)(\d+)$/);
  if (!match) return null;
  try {
    const next = (BigInt(match[2]) + 1n).toString().padStart(match[2].length, '0');
    return match[1] + next;
  } catch (e) {
    return null;
  }
}

function flipSignal(sig) {
  return sig === 'BIG' ? 'SMALL' : 'BIG';
}

function extractRows(payload) {
  const found = [], seen = new Set();
  function walk(n) {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const issue = n.issueNumber ?? n.issue_number ?? n.issue ?? n.periodNumber;
    const raw = n.number ?? n.resultNumber ?? n.result_number ?? n.openNumber;
    if (issue !== undefined && raw !== undefined) {
      const m = String(raw).match(/(?:^|\D)([0-9])(?:\D|$)/);
      if (m) {
        const number = +m[1];
        found.push({ issue: String(issue), number, value: number >= 5 ? 'BIG' : 'SMALL' });
      }
    }
    Object.values(n).forEach(walk);
  }
  walk(payload);
  return [...new Map(found.map(x => [x.issue, x])).values()].sort((a, b) => a.issue.localeCompare(b.issue, undefined, { numeric: true }));
}

async function fetchLatestData() {
  const urls = API_ENDPOINTS[GAME_MODE];
  for (const url of urls) {
    try {
      const res = await axios.get(`${url}?ts=${Date.now()}`, { timeout: 3500 });
      if (res.data) {
        const rows = extractRows(res.data);
        if (rows && rows.length >= 5) return rows;
      }
    } catch (e) {}
  }
  return null;
}

// ==========================================
// 3. MESSAGE DISPATCHER
// ==========================================
async function sendTelegramMessage(text) {
  if (!CHANNEL_ID) {
    console.log('⚠️ Waiting for channel connection. Please post a message in your channel once.');
    return;
  }
  try {
    await bot.sendMessage(CHANNEL_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Telegram Send Error:', err.message);
  }
}

// ==========================================
// 4. MAIN MONITORING LOOP
// ==========================================
async function checkAndPredict() {
  if (busy) return;
  busy = true;

  try {
    const rows = await fetchLatestData();
    if (!rows || rows.length < 5) {
      busy = false;
      return;
    }

    const latestResult = rows[rows.length - 1];

    // Win/Loss check
    if (lastProcessedIssue && latestResult.issue > lastProcessedIssue) {
      if (pendingPrediction && String(latestResult.issue) === String(pendingPrediction.issue)) {
        const isWin = latestResult.value === pendingPrediction.pred;

        let resultMsg = `📊 *RESULT UPDATE*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🎯 Period: \`${latestResult.issue}\`\n` +
          `🎲 Result: *${latestResult.value} (${latestResult.number})*\n` +
          `📌 Status: ${isWin ? '✅ *WIN*' : '❌ *LOSS*'}\n` +
          `📈 Level: *Level ${pendingPrediction.level}*\n` +
          `━━━━━━━━━━━━━━━━━━━━`;

        await sendTelegramMessage(resultMsg);

        if (isWin) {
          currentLevel = 1;
        } else {
          currentLevel = Math.min(10, currentLevel + 1);
        }
        pendingPrediction = null;
      }
      lastProcessedIssue = latestResult.issue;
    }

    if (!lastProcessedIssue) {
      lastProcessedIssue = latestResult.issue;
    }

    // New Signal calculation
    if (!pendingPrediction) {
      const nextIssue = lg_nextIssueId(latestResult.issue);
      const reversedRows = rows.slice().reverse();
      const last5Numbers = reversedRows.slice(0, REQUIRED_RESULTS).map(r => r.number);
      const details = computePredictionDetails(last5Numbers);

      if (details && nextIssue) {
        let finalPred = details.prediction;
        const isRev = REVERSE_LEVELS.includes(currentLevel);

        if (isRev) {
          finalPred = flipSignal(finalPred);
        }

        pendingPrediction = {
          issue: nextIssue,
          pred: finalPred,
          level: currentLevel,
          rev: isRev
        };

        let signalMsg = `🚀 *SPIDER SIGNAL (${GAME_MODE.toUpperCase()})*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🎯 Period: \`${nextIssue}\`\n` +
          `🔥 Prediction: *${finalPred}*\n` +
          `📊 Current Level: *Level ${currentLevel}*\n` +
          `${isRev ? '⚡ _(Reverse Engine Active)_\n' : ''}` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📌 _Maintain 10-level risk management balance._`;

        await sendTelegramMessage(signalMsg);
        console.log(`[Signal Sent] Period: ${nextIssue} | Pred: ${finalPred} | Level: ${currentLevel}`);
      }
    }
  } catch (error) {
    console.error('Bot Loop Error:', error.message);
  } finally {
    busy = false;
  }
}

// Har 4 second me poll karega
setInterval(checkAndPredict, 4000);
console.log('🤖 Telegram Bot Started. Waiting for channel sync...');
      
