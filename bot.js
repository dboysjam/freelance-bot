require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const scraper = require('./scraper');
const payments = require('./payments');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ BOT_TOKEN not found in .env file');
  process.exit(1);
}

const PORT = process.env.PORT || 10000;
const bot = new Telegraf(TOKEN);

// ─── DATA STORE ─────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
let data = { users: {}, jobs: {}, reviews: {} };
let jobIdCounter = 1;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      data = JSON.parse(raw);
      jobIdCounter = data._counter || 1;
    }
  } catch (e) { console.error('Load error:', e.message); }
}
function saveData() {
  data._counter = jobIdCounter;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error('Save error:', e.message); }
}
loadData();

// ─── USER STATE ─────────────────────────────────────────────
const userState = {};

// ─── CATEGORIES ─────────────────────────────────────────────
const SKILL_CATEGORIES = [
  '💻 Web Dev', '📱 Mobile Dev', '🎨 Design', '✍️ Writing',
  '📊 Marketing', '🔧 Data Entry', '🛠️ Virtual Assistant',
  '🎬 Video/Editing', '💰 Finance/Accounting', '📈 Business/Consulting',
];

// ─── HELPERS ────────────────────────────────────────────────
function getUser(ctx) {
  const id = ctx.from.id;
  if (!data.users[id]) {
    data.users[id] = {
      id, username: ctx.from.username || '', firstName: ctx.from.first_name || '',
      joinedAt: Date.now(), role: null, balance: 0, skills: [],
      bio: '', portfolio: '', rating: 0, ratingCount: 0,
    };
    saveData();
  }
  return data.users[id];
}

function formattedDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function mainMenu(ctx, user) {
  const name = ctx.from.first_name || 'there';
  const role = user.role ? `👤 Role: *${user.role}*` : '👤 No role set';
  let buttons = [
    [Markup.button.callback('💼 Browse Jobs', 'browse_jobs')],
    [Markup.button.callback('📋 My Jobs', 'my_jobs')],
    [Markup.button.callback('👤 My Profile', 'view_profile')],
    [Markup.button.callback('💰 Balance', 'check_balance')],
  ];
  if (user.role === 'client') {
    buttons.splice(1, 0, [Markup.button.callback('➕ Post a Job', 'post_job')]);
  }
  buttons.push([Markup.button.callback('🌐 Live Jobs (Web)', 'live_jobs_menu')]);
  buttons.push([Markup.button.callback('💳 Wallet', 'wallet_menu')]);
  buttons.push([Markup.button.callback('⚙️ Settings', 'settings')]);
  return ctx.replyWithMarkdown(
    `🏆 *Freelance Bot*\n\nWelcome back, *${escapeMarkdown(name)}*!\n${role}\n\n_Your freelance marketplace on Telegram_\n_🌐 Live Jobs from Upwork, Freelancer, Remote OK & more_\n_💳 Real payments via Stripe_`,
    Markup.inlineKeyboard(buttons)
  );
}

// ─── HTTP HEALTH & STRIPE WEBHOOK ──────────────────────────
const app = express();
app.get('/', (req, res) => res.send('Freelance Bot is running 🤖'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Stripe webhook — needs raw body
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  return payments.handleWebhook(req, res, data, saveData);
});
const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health server listening on port ${PORT}`);
});

// ─── START ──────────────────────────────────────────────────
bot.start((ctx) => {
  getUser(ctx);
  const name = ctx.from.first_name || 'there';
  return ctx.replyWithMarkdown(
    `🚀 *Welcome to Freelance Bot, ${escapeMarkdown(name)}!*\n\n` +
    `I connect freelancers with clients. Find work or hire talent right here on Telegram.\n\n` +
    `First, let's set your role:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🧑‍💼 I want to hire (Client)', 'set_role_client')],
      [Markup.button.callback('🛠️ I want to work (Freelancer)', 'set_role_freelancer')],
    ])
  );
});

// ─── ROLE SELECTION ─────────────────────────────────────────
bot.action('set_role_client', (ctx) => {
  const user = getUser(ctx); user.role = 'client'; saveData();
  ctx.answerCbQuery('✅ You are now a Client!');
  return mainMenu(ctx, user);
});
bot.action('set_role_freelancer', (ctx) => {
  const user = getUser(ctx); user.role = 'freelancer'; saveData();
  ctx.answerCbQuery('✅ You are now a Freelancer!');
  return mainMenu(ctx, user);
});
bot.action('main_menu', (ctx) => {
  const user = getUser(ctx); ctx.answerCbQuery();
  return mainMenu(ctx, user);
});

// ─── POST A JOB ─────────────────────────────────────────────
bot.action('post_job', (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'post_title' };
  return ctx.replyWithMarkdown(
    `📝 *Post a New Job*\n\nPlease send me the *job title* (e.g. "Build a WordPress Website")\n\nType /cancel to cancel.`
  );
});

// ─── BROWSE LOCAL JOBS ──────────────────────────────────────
function showJobList(ctx, edit = false) {
  const allJobs = Object.values(data.jobs).filter(j => j.status === 'open');
  const id = ctx.from.id;
  let page = userState[id]?.jobPage || 0;
  const perPage = 5;
  const totalPages = Math.ceil(allJobs.length / perPage);
  if (page >= totalPages) page = 0;
  const jobsToShow = allJobs.slice(page * perPage, (page + 1) * perPage);
  userState[id] = { ...userState[id], jobPage: page };
  let msg = `*💼 Available Jobs* (Page ${page + 1}/${totalPages})\n\n`;
  const buttons = [];
  for (const job of jobsToShow) {
    msg += `*${escapeMarkdown(job.title)}*\n💰 $${job.budget} · 📂 ${job.category}\n👤 by ${escapeMarkdown(job.clientName)} · ${formattedDate(job.createdAt)}\n\n`;
    buttons.push([Markup.button.callback(`📋 ${job.title.substring(0, 30)}`, `view_job_${job.id}`)]);
  }
  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('◀️ Prev', 'jobs_prev'));
  if (page < totalPages - 1) navButtons.push(Markup.button.callback('Next ▶️', 'jobs_next'));
  if (navButtons.length) buttons.push(navButtons);
  buttons.push([Markup.button.callback('🔙 Back', 'main_menu')]);
  if (edit) {
    return ctx.editMessageText(msg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    }).catch(() => ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons)));
  }
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
}

bot.action('browse_jobs', async (ctx) => {
  ctx.answerCbQuery();
  const allJobs = Object.values(data.jobs).filter(j => j.status === 'open');
  if (allJobs.length === 0) {
    return ctx.replyWithMarkdown(
      '📭 *No jobs available right now.*\n\nCheck back later or post your own!',
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'main_menu')]])
    );
  }
  userState[ctx.from.id] = { ...userState[ctx.from.id], jobPage: 0 };
  return showJobList(ctx);
});
bot.action('jobs_prev', async (ctx) => {
  const id = ctx.from.id;
  userState[id] = { ...userState[id], jobPage: Math.max(0, (userState[id]?.jobPage || 0) - 1) };
  ctx.answerCbQuery();
  return showJobList(ctx, true);
});
bot.action('jobs_next', async (ctx) => {
  const allJobs = Object.values(data.jobs).filter(j => j.status === 'open');
  const totalPages = Math.ceil(allJobs.length / 5);
  const id = ctx.from.id;
  userState[id] = { ...userState[id], jobPage: Math.min(totalPages - 1, (userState[id]?.jobPage || 0) + 1) };
  ctx.answerCbQuery();
  return showJobList(ctx, true);
});

// ─── VIEW JOB ───────────────────────────────────────────────
bot.action(/view_job_(\d+)/, (ctx) => {
  ctx.answerCbQuery();
  const jobId = parseInt(ctx.match[1]);
  const job = data.jobs[jobId];
  if (!job) return ctx.reply('❌ Job not found.');
  const user = getUser(ctx);
  let msg = `*${escapeMarkdown(job.title)}*\n━━━━━━━━━━━━━━━━\n💰 *Budget:* $${job.budget}\n📂 *Category:* ${job.category}\n👤 *Client:* ${escapeMarkdown(job.clientName)}\n📅 *Posted:* ${formattedDate(job.createdAt)}\n\n*Description:*\n${escapeMarkdown(job.description)}\n`;
  const buttons = [[Markup.button.callback('🔙 Back to Jobs', 'browse_jobs')]];
  if (user.role === 'freelancer' && job.status === 'open') {
    const applied = job.applicants && job.applicants.some(a => a.id === user.id);
    if (!applied) buttons.push([Markup.button.callback('✋ Apply for this Job', `apply_job_${job.id}`)]);
    else msg += `\n_✅ You have already applied for this job._`;
  }
  if (user.id === job.clientId) {
    buttons.push([Markup.button.callback('❌ Close Job', `close_job_${job.id}`)]);
    if (job.applicants && job.applicants.length > 0) buttons.push([Markup.button.callback('👥 View Applicants', `applicants_${job.id}`)]);
  }
  buttons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
});

// ─── APPLY FOR JOB ──────────────────────────────────────────
bot.action(/apply_job_(\d+)/, (ctx) => {
  ctx.answerCbQuery();
  const jobId = parseInt(ctx.match[1]);
  const job = data.jobs[jobId];
  if (!job) return ctx.reply('❌ Job not found.');
  const user = getUser(ctx);
  if (!user.bio || user.bio.length < 10) {
    return ctx.replyWithMarkdown(
      `⚠️ Please set your *bio* and *skills* first.\n\nUse /setbio to set your bio.\nUse /addskill to add your skills.`,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `view_job_${jobId}`)]])
    );
  }
  if (!job.applicants) job.applicants = [];
  if (job.applicants.some(a => a.id === user.id)) return ctx.reply('✅ You already applied for this job.');
  job.applicants.push({ id: user.id, username: user.username || user.firstName, appliedAt: Date.now() });
  saveData();
  try { bot.telegram.sendMessage(job.clientId, `📩 *New Application!*\n\nSomeone applied for your job *"${escapeMarkdown(job.title)}"*\n\nUse /myjobs to review applicants.`, { parse_mode: 'Markdown' }); } catch (e) {}
  return ctx.replyWithMarkdown(`✅ *Application sent!*\n\nThe client will review your profile and contact you if interested.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Jobs', 'browse_jobs')]]));
});

// ─── CLOSE JOB ──────────────────────────────────────────────
bot.action(/close_job_(\d+)/, (ctx) => {
  ctx.answerCbQuery();
  const jobId = parseInt(ctx.match[1]);
  const job = data.jobs[jobId];
  if (!job) return ctx.reply('❌ Job not found.');
  if (job.clientId !== ctx.from.id) return ctx.reply('❌ Not your job.');
  job.status = 'closed'; saveData();
  return ctx.replyWithMarkdown(`✅ Job *"${escapeMarkdown(job.title)}"* has been closed.`, Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
});

// ─── VIEW APPLICANTS ────────────────────────────────────────
bot.action(/applicants_(\d+)/, (ctx) => {
  ctx.answerCbQuery();
  const jobId = parseInt(ctx.match[1]);
  const job = data.jobs[jobId];
  if (!job) return ctx.reply('❌ Job not found.');
  if (!job.applicants || job.applicants.length === 0) return ctx.replyWithMarkdown('📭 *No applicants yet.*', Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `view_job_${jobId}`)]]));
  let msg = `*👥 Applicants for "${escapeMarkdown(job.title)}"*\n\n`;
  const buttons = [];
  for (const app of job.applicants) {
    const appUser = data.users[app.id];
    const rating = appUser ? `${'⭐'.repeat(Math.max(1, Math.round(appUser.rating || 0)))}` : '⭐';
    msg += `👤 *${escapeMarkdown(app.username || 'Unknown')}*\n📅 Applied: ${formattedDate(app.appliedAt)}\n${rating}\n`;
    if (appUser?.skills?.length) msg += `🛠️ Skills: ${appUser.skills.join(', ')}\n`;
    msg += '\n';
    buttons.push([Markup.button.callback(`💬 Contact @${app.username || app.id}`, `contact_${app.id}`)]);
  }
  buttons.push([Markup.button.callback('🔙 Back', `view_job_${jobId}`)]);
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
});

// ─── MY JOBS ────────────────────────────────────────────────
bot.action('my_jobs', (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  const myJobs = Object.values(data.jobs).filter(j => j.clientId === user.id);
  const myApps = Object.values(data.jobs).filter(j => j.applicants && j.applicants.some(a => a.id === user.id));
  let msg = `*📋 Your Jobs*\n\n`;
  const buttons = [];
  if (user.role === 'client') {
    if (myJobs.length === 0) msg += `You haven't posted any jobs yet.\n`;
    else {
      msg += `*Jobs you posted:*\n`;
      for (const j of myJobs) {
        const status = j.status === 'open' ? '🟢 Open' : '🔴 Closed';
        msg += `  ${status} *${escapeMarkdown(j.title)}* - $${j.budget}\n`;
        buttons.push([Markup.button.callback(`📋 ${j.title.substring(0, 30)}`, `view_job_${j.id}`)]);
      }
    }
    buttons.push([Markup.button.callback('➕ Post a New Job', 'post_job')]);
  }
  if (myApps.length > 0) {
    msg += `\n*Jobs you applied for:*\n`;
    for (const j of myApps) {
      const status = j.status === 'open' ? '🟢 Open' : '🔴 Closed';
      msg += `  ${status} *${escapeMarkdown(j.title)}* - $${j.budget}\n`;
    }
  }
  if (myApps.length === 0 && user.role === 'freelancer') {
    msg += `You haven't applied for any jobs yet. Browse below!\n`;
    buttons.push([Markup.button.callback('💼 Browse Jobs', 'browse_jobs')]);
  }
  buttons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
});

// ─── PROFILE ────────────────────────────────────────────────
bot.action('view_profile', (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  let msg = `*👤 Your Profile*\n\n*Name:* ${escapeMarkdown(user.firstName)}\n*Username:* @${escapeMarkdown(user.username || 'none')}\n*Role:* ${user.role || '❌ Not set'}\n*Balance:* 💰 $${user.balance}\n*Rating:* ${'⭐'.repeat(Math.max(1, Math.round(user.rating || 0)))} (${user.ratingCount} ratings)\n`;
  if (user.skills?.length) msg += `*Skills:* ${user.skills.join(', ')}\n`;
  else msg += `*Skills:* ❌ None set\n`;
  if (user.bio) msg += `\n*Bio:*\n${escapeMarkdown(user.bio)}\n`;
  const buttons = [
    [Markup.button.callback('✏️ Set Bio', 'set_bio')],
    [Markup.button.callback('🛠️ Manage Skills', 'manage_skills')],
    [Markup.button.callback('🎯 Switch Role', 'switch_role')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')],
  ];
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
});

bot.action('set_bio', (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'set_bio' };
  return ctx.replyWithMarkdown(`✏️ *Set Your Bio*\n\nTell clients/freelancers about yourself, your experience, and what you offer.\n\nType /cancel to cancel.`);
});

bot.action('manage_skills', async (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  let msg = `*🛠️ Your Skills*\n\n`;
  if (user.skills?.length) msg += `Current skills: ${user.skills.join(', ')}\n\n`;
  else msg += `You haven't added any skills yet.\n\n`;
  msg += `Select a category to add a skill:`;
  const buttons = SKILL_CATEGORIES.map(cat => [Markup.button.callback(cat, `skill_cat_${cat}`)]);
  buttons.push([Markup.button.callback('🔙 Back', 'view_profile')]);
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
});

bot.action(/skill_cat_(.*)/, (ctx) => {
  ctx.answerCbQuery();
  const category = ctx.match[1];
  const user = getUser(ctx);
  if (!user.skills) user.skills = [];
  const skillName = category.replace(/^[^\s]+\s/, '');
  if (!user.skills.includes(skillName)) {
    user.skills.push(skillName); saveData();
    ctx.replyWithMarkdown(`✅ Added *${escapeMarkdown(skillName)}* to your skills!`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'manage_skills')]]));
  } else {
    user.skills = user.skills.filter(s => s !== skillName); saveData();
    ctx.replyWithMarkdown(`🗑️ Removed *${escapeMarkdown(skillName)}* from your skills.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'manage_skills')]]));
  }
});

bot.action('switch_role', (ctx) => {
  ctx.answerCbQuery();
  return ctx.replyWithMarkdown(`*🎯 Switch Role*\n\nWhat would you like to switch to?`, Markup.inlineKeyboard([
    [Markup.button.callback('🧑‍💼 Client (Hire)', 'set_role_client')],
    [Markup.button.callback('🛠️ Freelancer (Work)', 'set_role_freelancer')],
    [Markup.button.callback('🔙 Back', 'view_profile')],
  ]));
});

// ─── WALLET / PAYMENTS ─────────────────────────────────────
bot.action('check_balance', (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  const stripeConfigured = payments.isConfigured();
  let msg = `💳 *Your Wallet*\n\n*Balance:* $${(user.balance || 0).toFixed(2)}\n`;
  if (user.transactions?.length) {
    msg += `*Transactions:* ${user.transactions.length}\n`;
  }
  msg += `\n_Payments powered by Stripe_ 💳\n`;
  const buttons = [
    [Markup.button.callback('💰 Deposit Funds', 'deposit_menu')],
    [Markup.button.callback('📊 Transaction History', 'transaction_history')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')],
  ];
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
});

bot.action('wallet_menu', (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  let msg = `💳 *Your Wallet*\n\n*Balance:* $${(user.balance || 0).toFixed(2)}\n`;
  msg += `\nAdd funds to pay freelancers or receive payments for your work.`;
  const buttons = [
    [Markup.button.callback('💰 Deposit Funds', 'deposit_menu')],
    [Markup.button.callback('📊 Transactions', 'transaction_history')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')],
  ];
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
});

bot.action('deposit_menu', (ctx) => {
  ctx.answerCbQuery();
  if (!payments.isConfigured()) {
    return ctx.replyWithMarkdown(
      `⚠️ *Stripe is being set up.*\n\nThe admin needs to add a Stripe secret key. Once configured, you can deposit funds here.\n\n_Check back soon!_`,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'check_balance')]])
    );
  }
  userState[ctx.from.id] = { step: 'deposit_amount' };
  return ctx.replyWithMarkdown(
    `💰 *Deposit Funds*\n\nHow much would you like to deposit?\n\nMinimum: $1\n\nEnter the amount in USD (e.g. 50)\n\nType /cancel to cancel.`
  );
});

bot.action('transaction_history', (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  const txns = user.transactions || [];
  if (txns.length === 0) {
    return ctx.replyWithMarkdown(
      '📊 *No transactions yet.*',
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'wallet_menu')]])
    );
  }
  let msg = `*📊 Transaction History*\n\n`;
  const recent = txns.slice(-10).reverse();
  for (const t of recent) {
    const emoji = t.type === 'deposit' ? '💰' : t.type === 'payment_received' ? '📥' : '📤';
    msg += `${emoji} *${t.type.replace('_', ' ').toUpperCase()}* $${t.amount}\n`;
    if (t.date) msg += `   ${formattedDate(t.date)}\n`;
    msg += '\n';
  }
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'wallet_menu')]]));
});

bot.action('settings', (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  return ctx.replyWithMarkdown(`*⚙️ Settings*\n\n👤 Role: *${user.role || 'Not set'}*\n🛠️ Skills: ${user.skills?.length || 0} skills\n📝 Bio: ${user.bio ? '✅ Set' : '❌ Not set'}\n\n_Use the profile menu to update your info._`, Markup.inlineKeyboard([[Markup.button.callback('👤 Edit Profile', 'view_profile')], [Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
});

// ─── LIVE JOBS FROM WEB ────────────────────────────────────
bot.action('live_jobs_menu', async (ctx) => {
  ctx.answerCbQuery();
  const sources = scraper.WORKING_SOURCES;
  let msg = `*🌐 Live Freelance Jobs*\n\n`;
  msg += `*Search jobs from across the web:*\n\n`;
  const buttons = sources.map(s => [Markup.button.callback(`${s.icon} ${s.name}`, `live_source_${s.name}`)]);
  buttons.push([Markup.button.callback('🔍 Search All Live Jobs', 'live_search'), Markup.button.callback('🔄 Refresh', 'live_refresh')]);
  buttons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
});

bot.action('live_search', async (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'live_search' };
  return ctx.replyWithMarkdown(
    `🔍 *Search Live Jobs*\n\nTell me what you're looking for (e.g. "React", "Design", "Writing", "Python")\n\nType /cancel to cancel.`
  );
});

function showLiveJobs(ctx, jobs, title, edit = false) {
  const id = ctx.from.id;
  let page = userState[id]?.livePage || 0;
  const perPage = 4;
  const totalPages = Math.ceil(jobs.length / perPage);
  if (page >= totalPages) page = 0;
  const jobsToShow = jobs.slice(page * perPage, (page + 1) * perPage);
  userState[id] = { ...userState[id], livePage: page, liveJobs: jobs, liveTitle: title };

  let msg = `*🌐 ${escapeMarkdown(title)}* (Page ${page + 1}/${totalPages})\n\n`;
  const buttons = [];

  for (const job of jobsToShow) {
    msg += `${job.icon || '📌'} *${escapeMarkdown(job.title.substring(0, 50))}*\n`;
    msg += `💰 ${job.budget || 'N/A'} · 📂 ${job.source}\n`;
    const desc = job.description?.replace(/\n/g, ' ').substring(0, 100) || '';
    if (desc) msg += `📝 ${escapeMarkdown(desc)}...\n`;
    if (job.skills?.length) msg += `🏷️ ${job.skills.slice(0, 3).join(', ')}\n`;
    msg += '\n';
    buttons.push([Markup.button.callback('🔗 Open in Browser', `live_url_${encodeURIComponent(job.url)}`)]);
  }

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('◀️ Prev', 'live_prev'));
  if (page < totalPages - 1) navButtons.push(Markup.button.callback('Next ▶️', 'live_next'));
  if (navButtons.length) buttons.push(navButtons);
  buttons.push([Markup.button.callback('🔙 Back', 'live_jobs_menu'), Markup.button.callback('🏠 Main Menu', 'main_menu')]);

  if (edit) {
    return ctx.editMessageText(msg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    }).catch(() => ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons)));
  }
  return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
}

bot.action('live_prev', async (ctx) => {
  const id = ctx.from.id;
  userState[id] = { ...userState[id], livePage: Math.max(0, (userState[id]?.livePage || 0) - 1) };
  ctx.answerCbQuery();
  const jobs = userState[id]?.liveJobs || [];
  const title = userState[id]?.liveTitle || 'Live Jobs';
  if (jobs.length === 0) return ctx.reply('No jobs cached. Please refresh.');
  return showLiveJobs(ctx, jobs, title, true);
});

bot.action('live_next', async (ctx) => {
  const id = ctx.from.id;
  const jobs = userState[id]?.liveJobs || [];
  const totalPages = Math.ceil(jobs.length / 4);
  userState[id] = { ...userState[id], livePage: Math.min(totalPages - 1, (userState[id]?.livePage || 0) + 1) };
  ctx.answerCbQuery();
  const title = userState[id]?.liveTitle || 'Live Jobs';
  if (jobs.length === 0) return ctx.reply('No jobs cached. Please refresh.');
  return showLiveJobs(ctx, jobs, title, true);
});

bot.action('live_refresh', async (ctx) => {
  ctx.answerCbQuery('Fetching latest jobs...');
  ctx.reply('🔄 *Fetching jobs from freelance sites...*', { parse_mode: 'Markdown' }).then(async () => {
    const jobs = await scraper.fetchAllJobs(true);
    const id = ctx.from.id;
    userState[id] = { ...userState[id], livePage: 0, liveJobs: jobs, liveTitle: 'All Live Jobs' };
    if (jobs.length === 0) {
      return ctx.replyWithMarkdown(
        '⚠️ Could not fetch jobs right now. The freelance sites may be blocking requests.\n\n_Try again later or browse local jobs._',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'live_jobs_menu')]])
      );
    }
    return showLiveJobs(ctx, jobs, `All Live Jobs (${jobs.length} found)`);
  });
});

bot.action(/live_source_(.*)/, async (ctx) => {
  ctx.answerCbQuery();
  const sourceName = ctx.match[1];
  ctx.reply(`🔄 Fetching ${sourceName} jobs...`, { parse_mode: 'Markdown' }).then(async () => {
    const allJobs = await scraper.fetchAllJobs(true);
    const filtered = scraper.getJobsBySource(sourceName, allJobs);
    const id = ctx.from.id;
    userState[id] = { ...userState[id], livePage: 0, liveJobs: filtered, liveTitle: sourceName };
    if (filtered.length === 0) {
      return ctx.replyWithMarkdown(
        `⚠️ No jobs found from ${sourceName} right now. They may be blocking automated requests.`,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'live_jobs_menu')]])
      );
    }
    return showLiveJobs(ctx, filtered, `${sourceName} (${filtered.length} jobs)`);
  });
});

bot.action(/live_url_(.*)/, async (ctx) => {
  ctx.answerCbQuery();
  const url = decodeURIComponent(ctx.match[1]);
  if (url && url.startsWith('http')) {
    return ctx.reply(`🔗 *Open this link:*\n${url}`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[Markup.button.url('🌐 Open', url)]] },
    });
  }
  return ctx.reply('❌ Invalid URL.');
});

// ─── TEXT HANDLER ───────────────────────────────────────────
bot.on('text', (ctx) => {
  const text = ctx.message.text;
  const id = ctx.from.id;
  const state = userState[id];
  if (!state || !state.step) return ctx.replyWithMarkdown('Use the menu buttons below to navigate:', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
  if (text === '/cancel') { delete userState[id]; return ctx.replyWithMarkdown('❌ Cancelled.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]])); }

  // ─── Live Jobs Search ───
  if (state.step === 'live_search') {
    delete userState[id];
    ctx.reply(`🔍 Searching for "${text}"...`).then(async () => {
      const allJobs = await scraper.fetchAllJobs();
      const results = scraper.searchJobs(text, allJobs);
      if (results.length === 0) return ctx.reply(`No results found for "${text}".`);
      const uid = ctx.from.id;
      userState[uid] = { ...userState[uid], livePage: 0, liveJobs: results, liveTitle: `Search: ${text}` };
      return showLiveJobs(ctx, results, `Search: "${text}" (${results.length} results)`);
    });
    return;
  }

  // ─── Deposit Amount ───
  if (state.step === 'deposit_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 1) return ctx.reply('❌ Please enter a valid amount. Minimum: $1');
    delete userState[id];
    ctx.reply(`⏳ *Creating payment link...*`, { parse_mode: 'Markdown' }).then(async () => {
      const result = await payments.createDepositSession(
        id, amount, ctx.from.username || ctx.from.first_name,
        'https://t.me/joemama84_bot', 'https://t.me/joemama84_bot'
      );
      if (result.error) {
        return ctx.reply(`❌ Payment error: ${result.error}`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'wallet_menu')]]));
      }
      return ctx.replyWithMarkdown(
        `✅ *Payment link created!*\n\nClick below to pay **$${amount.toFixed(2)}** via Stripe:\n\n[💳 Pay $${amount.toFixed(2)}](${result.url})`,
        Markup.inlineKeyboard([
          [Markup.button.url('💳 Pay with Card', result.url)],
          [Markup.button.callback('🔙 Back', 'wallet_menu')],
        ])
      );
    });
    return;
  }

  // ─── Set Bio ───
  if (state.step === 'set_bio') {
    const user = getUser(ctx); user.bio = text; saveData(); delete userState[id];
    return ctx.replyWithMarkdown('✅ *Bio updated!*', Markup.inlineKeyboard([[Markup.button.callback('👤 View Profile', 'view_profile')]]));
  }

  // ─── Post Job Flow ───
  if (state.step === 'post_title') {
    state.title = text; state.step = 'post_category';
    const buttons = SKILL_CATEGORIES.map(cat => [Markup.button.callback(cat, `jobcat_${cat}`)]);
    buttons.push([Markup.button.callback('❌ Cancel', 'cancel')]);
    return ctx.replyWithMarkdown(`📂 *Select a category* for your job:`, Markup.inlineKeyboard(buttons));
  }
  if (state.step === 'post_description') {
    state.description = text; state.step = 'post_budget';
    return ctx.replyWithMarkdown(`💰 *Set your budget*\n\nEnter the amount in USD (e.g. 500 for $500)\n\nType /cancel to cancel.`);
  }
  if (state.step === 'post_budget') {
    const budget = parseFloat(text);
    if (isNaN(budget) || budget <= 0) return ctx.reply('❌ Please enter a valid number (e.g. 500)');
    state.budget = budget; state.step = 'post_confirm';
    let msg = `*📋 Job Summary*\n\n*Title:* ${escapeMarkdown(state.title)}\n*Category:* ${state.category}\n*Description:* ${escapeMarkdown(state.description)}\n*Budget:* $${budget}\n\nDoes everything look correct?`;
    return ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm & Post', 'confirm_job')], [Markup.button.callback('❌ Cancel', 'cancel')]]));
  }
});

bot.action(/jobcat_(.*)/, (ctx) => {
  ctx.answerCbQuery();
  const id = ctx.from.id;
  if (!userState[id] || userState[id].step !== 'post_category') return;
  userState[id].category = ctx.match[1]; userState[id].step = 'post_description';
  return ctx.replyWithMarkdown(`✍️ *Job description*\n\nDescribe the job in detail — what needs to be done, requirements, deadlines, etc.\n\nType /cancel to cancel.`);
});

bot.action('confirm_job', (ctx) => {
  ctx.answerCbQuery();
  const id = ctx.from.id;
  const state = userState[id];
  if (!state || !state.title) return;
  const user = getUser(ctx);
  const job = { id: jobIdCounter++, title: state.title, category: state.category, description: state.description, budget: state.budget, clientId: user.id, clientName: user.firstName || user.username || 'Anonymous', status: 'open', createdAt: Date.now(), applicants: [] };
  data.jobs[job.id] = job; saveData(); delete userState[id];
  return ctx.replyWithMarkdown(`✅ *Job Posted!*\n\nYour job *"${escapeMarkdown(job.title)}"* is now live for $${job.budget}.\n\nOther users can now find and apply for it.`, Markup.inlineKeyboard([[Markup.button.callback(`📋 View Job`, `view_job_${job.id}`)], [Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
});

bot.action('cancel', (ctx) => {
  ctx.answerCbQuery(); delete userState[ctx.from.id];
  return ctx.replyWithMarkdown('❌ Cancelled.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
});

// ─── COMMANDS ──────────────────────────────────────────────
bot.command('setbio', (ctx) => {
  const text = ctx.message.text.replace('/setbio', '').trim();
  if (!text) return ctx.reply('Usage: /setbio Your bio here');
  const user = getUser(ctx); user.bio = text; saveData();
  return ctx.reply('✅ Bio updated!');
});
bot.command('addskill', (ctx) => {
  const text = ctx.message.text.replace('/addskill', '').trim();
  if (!text) return ctx.reply('Usage: /addskill SkillName');
  const user = getUser(ctx);
  if (!user.skills) user.skills = [];
  if (!user.skills.includes(text)) { user.skills.push(text); saveData(); }
  return ctx.reply(`✅ Added skill: ${text}`);
});
bot.command('myjobs', (ctx) => {
  const user = getUser(ctx);
  const myJobs = Object.values(data.jobs).filter(j => j.clientId === user.id);
  if (myJobs.length === 0) return ctx.reply('You have no jobs posted.');
  for (const j of myJobs) ctx.replyWithMarkdown(`📋 *${escapeMarkdown(j.title)}*\n💰 $${j.budget} · ${j.applicants?.length || 0} applicants`, Markup.inlineKeyboard([[Markup.button.callback('View', `view_job_${j.id}`)]]));
});
bot.command('livejobs', async (ctx) => {
  ctx.reply('🔄 *Fetching latest freelance jobs...*', { parse_mode: 'Markdown' }).then(async () => {
    const jobs = await scraper.fetchAllJobs(true);
    const id = ctx.from.id;
    userState[id] = { ...userState[id], livePage: 0, liveJobs: jobs, liveTitle: 'All Live Jobs' };
    if (jobs.length === 0) return ctx.replyWithMarkdown('⚠️ No jobs fetched. Sites may be blocking requests.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
    return showLiveJobs(ctx, jobs, `All Live Jobs (${jobs.length} found)`);
  });
});
bot.command('search', async (ctx) => {
  const query = ctx.message.text.replace('/search', '').trim();
  if (!query) return ctx.reply('Usage: /search React developer');
  ctx.reply(`🔍 Searching for "${query}"...`).then(async () => {
    const allJobs = await scraper.fetchAllJobs();
    const results = scraper.searchJobs(query, allJobs);
    if (results.length === 0) return ctx.reply(`No results found for "${query}".`);
    const id = ctx.from.id;
    userState[id] = { ...userState[id], livePage: 0, liveJobs: results, liveTitle: `Search: ${query}` };
    return showLiveJobs(ctx, results, `Search: "${query}" (${results.length} results)`);
  });
});
bot.command('help', (ctx) => {
  return ctx.replyWithMarkdown(
    `*🤖 Freelance Bot Help*\n\n*Commands:*\n/start - Start the bot\n/setbio <text> - Set your bio\n/addskill <skill> - Add a skill\n/myjobs - View your posted jobs\n/livejobs - Browse live jobs from web\n/search <query> - Search live jobs\n/help - Show this message\n\n*Menu:* Use the buttons to browse jobs, post jobs, and manage your profile.`
  );
});

// ─── ERROR HANDLING ─────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
});

// ─── LAUNCH ─────────────────────────────────────────────────
bot.launch().then(() => {
  console.log('🤖 Freelance Bot is running!');
  console.log(`Bot: @joemama84_bot`);
}).catch((err) => {
  console.error('Failed to launch bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
