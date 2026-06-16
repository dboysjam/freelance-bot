const crypto = require('crypto');

// Cash App config from environment
const CASHAPP_TAG = process.env.CASHAPP_TAG || '$joemama84'; // Your $cashtag
const CASHAPP_EMAIL = process.env.CASHAPP_EMAIL || ''; // Optional: email for notifications

// ─── MANUAL DEPOSIT (Cash App) ─────────────────────────────
// Cash App doesn't have a bot API, so we use a manual flow:
// 1. User requests deposit
// 2. Bot shows $cashtag + amount
// 3. User sends via Cash App
// 4. Admin runs /confirm [user_id] [amount] to credit

async function createDepositRequest(userId, amountUSD, username) {
  if (amountUSD < 1) return { error: 'Minimum deposit is $1' };
  
  const depositId = crypto.randomBytes(4).toString('hex').toUpperCase();
  
  return {
    depositId,
    cashtag: CASHAPP_TAG,
    amount: amountUSD,
    instructions: [
      `1. Open Cash App`,
      `2. Send **$${amountUSD.toFixed(2)}** to **${CASHAPP_TAG}**`,
      `3. Include reference code: **${depositId}**`,
      `4. Reply with /paid ${depositId} after sending`,
    ],
    note: `Funds are credited manually after payment is confirmed.`,
  };
}

// ─── CONFIRM PAYMENT ───────────────────────────────────────
function confirmDeposit(dataStore, saveData, userId, amount, depositId) {
  if (!dataStore.users[userId]) return { error: 'User not found.' };
  
  const user = dataStore.users[userId];
  user.balance = (user.balance || 0) + amount;
  if (!user.transactions) user.transactions = [];
  user.transactions.push({
    type: 'deposit',
    method: 'cashapp',
    amount: amount,
    depositId: depositId || 'manual',
    date: Date.now(),
  });
  saveData();
  
  return { success: true, newBalance: user.balance };
}

// ─── UTILS ─────────────────────────────────────────────────
function isConfigured() {
  return CASHAPP_TAG && CASHAPP_TAG.startsWith('$');
}

function getCashtag() {
  return CASHAPP_TAG;
}

module.exports = {
  createDepositRequest,
  confirmDeposit,
  isConfigured,
  getCashtag,
};
