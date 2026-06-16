const Stripe = require('stripe');
const crypto = require('crypto');

let stripe = null;
let webhookSecret = '';

// Try to initialize — gracefully handles missing key
function init() {
  const key = process.env.STRIPE_SECRET_KEY;
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (key) {
    stripe = Stripe(key);
    return true;
  }
  return false;
}

init();

// ─── CREATE DEPOSIT CHECKOUT ──────────────────────────────
async function createDepositSession(userId, amountUSD, username, successUrl, cancelUrl) {
  if (!stripe) return { error: 'Stripe not configured. Add STRIPE_SECRET_KEY to .env' };
  if (amountUSD < 1) return { error: 'Minimum deposit is $1' };

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Freelance Bot Deposit',
            description: `Deposit $${amountUSD} to your Freelance Bot wallet`,
          },
          unit_amount: Math.round(amountUSD * 100), // cents
        },
        quantity: 1,
      }],
      metadata: {
        user_id: String(userId),
        username: username || 'unknown',
        type: 'deposit',
      },
      success_url: successUrl || 'https://t.me/joemama84_bot',
      cancel_url: cancelUrl || 'https://t.me/joemama84_bot',
    });

    return { url: session.url, id: session.id };
  } catch (err) {
    console.error('Stripe create session error:', err.message);
    return { error: err.message };
  }
}

// ─── CREATE PAYMENT (user to user) ─────────────────────────
async function createPaymentSession(fromUserId, toUserId, amountUSD, description, successUrl, cancelUrl) {
  if (!stripe) return { error: 'Stripe not configured.' };
  if (amountUSD < 1) return { error: 'Minimum payment is $1' };

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: description || 'Freelance Payment',
            description: `Payment of $${amountUSD} via Freelance Bot`,
          },
          unit_amount: Math.round(amountUSD * 100),
        },
        quantity: 1,
      }],
      metadata: {
        from_user_id: String(fromUserId),
        to_user_id: String(toUserId),
        type: 'payment',
        description: description || 'Freelance payment',
      },
      success_url: successUrl || 'https://t.me/joemama84_bot',
      cancel_url: cancelUrl || 'https://t.me/joemama84_bot',
    });

    return { url: session.url, id: session.id };
  } catch (err) {
    console.error('Stripe payment error:', err.message);
    return { error: err.message };
  }
}

// ─── HANDLE WEBHOOK ────────────────────────────────────────
function handleWebhook(req, res, dataStore, saveData) {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const sig = req.headers['stripe-signature'];

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // Fallback — parse raw event (less secure but works for testing)
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log(`🔔 Stripe webhook: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const metadata = session.metadata || {};
      const type = metadata.type || 'deposit';
      const amountUSD = (session.amount_total || 0) / 100;

      if (type === 'deposit') {
        const userId = parseInt(metadata.user_id);
        if (dataStore.users[userId]) {
          dataStore.users[userId].balance = (dataStore.users[userId].balance || 0) + amountUSD;
          if (!dataStore.users[userId].transactions) dataStore.users[userId].transactions = [];
          dataStore.users[userId].transactions.push({
            type: 'deposit',
            amount: amountUSD,
            stripeId: session.id,
            date: Date.now(),
          });
          saveData();
          console.log(`💰 Deposit: $${amountUSD} -> user ${userId}`);
        }
      } else if (type === 'payment') {
        // Payment from one user to another
        const fromId = parseInt(metadata.from_user_id);
        const toId = parseInt(metadata.to_user_id);
        if (dataStore.users[toId]) {
          dataStore.users[toId].balance = (dataStore.users[toId].balance || 0) + amountUSD;
          if (!dataStore.users[toId].transactions) dataStore.users[toId].transactions = [];
          dataStore.users[toId].transactions.push({
            type: 'payment_received',
            amount: amountUSD,
            from: fromId,
            description: metadata.description || 'Freelance payment',
            stripeId: session.id,
            date: Date.now(),
          });
          saveData();
          console.log(`💰 Payment: $${amountUSD} -> user ${toId} from user ${fromId}`);
        }
      }
      break;
    }
    case 'checkout.session.expired': {
      console.log('⏰ Checkout session expired:', event.data.object.id);
      break;
    }
  }

  return res.json({ received: true });
}

// ─── UTILS ─────────────────────────────────────────────────
function isConfigured() {
  return stripe !== null;
}

module.exports = {
  createDepositSession,
  createPaymentSession,
  handleWebhook,
  isConfigured,
};
