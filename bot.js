require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

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
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Save error:', e.message); }
}

loadData();

// ─── USER STATE (in-memory for multi-step dialogs) ─────────
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
  buttons.push([Markup.button.callback('⚙️ Settings', 'settings')]);
  return ctx.replyWithMarkdown(
    `🏆 *Freelance Bot*\n\nWelcome back, *${escapeMarkdown(name)}*!\n${role}\n\n_Your freelance marketplace on Telegram_`,
    Markup.inlineKeyboard(buttons)
  );
}

// ─── HTTP HEALTH (for Render / cloud) ──────────────────────
const app = express();
app.get('/', (req, res) => res.send('Freelance Bot is running 🤖'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
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

// ─── BROWSE JOBS ────────────────────────────────────────────
function showJobList(ctx, edit = false, chatId, messageId) {
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
  const id = ctx.from.id;
  userState[id] = { ...userState[id], jobPage: 0 };
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

bot.action('check_balance', (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  return ctx.replyWithMarkdown(`💰 *Your Balance*\n\n*Current Balance:* $${user.balance}\n\n_Note: This is a simulated balance. Real payment integration coming soon._`, Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
});

bot.action('settings', (ctx) => {
  ctx.answerCbQuery();
  const user = getUser(ctx);
  return ctx.replyWithMarkdown(`*⚙️ Settings*\n\n👤 Role: *${user.role || 'Not set'}*\n🛠️ Skills: ${user.skills?.length || 0} skills\n📝 Bio: ${user.bio ? '✅ Set' : '❌ Not set'}\n\n_Use the profile menu to update your info._`, Markup.inlineKeyboard([[Markup.button.callback('👤 Edit Profile', 'view_profile')], [Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
});

// ─── TEXT HANDLER ───────────────────────────────────────────
bot.on('text', (ctx) => {
  const text = ctx.message.text;
  const id = ctx.from.id;
  const state = userState[id];
  if (!state || !state.step) return ctx.replyWithMarkdown('Use the menu buttons below to navigate:', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
  if (text === '/cancel') { delete userState[id]; return ctx.replyWithMarkdown('❌ Cancelled.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]])); }
  if (state.step === 'set_bio') {
    const user = getUser(ctx); user.bio = text; saveData(); delete userState[id];
    return ctx.replyWithMarkdown('✅ *Bio updated!*', Markup.inlineKeyboard([[Markup.button.callback('👤 View Profile', 'view_profile')]]));
  }
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
bot.command('help', (ctx) => {
  return ctx.replyWithMarkdown(
    `*🤖 Freelance Bot Help*\n\n*Commands:*\n/start - Start the bot\n/setbio <text> - Set your bio\n/addskill <skill> - Add a skill\n/myjobs - View your posted jobs\n/help - Show this message\n\n*Menu:* Use the buttons to browse jobs, post jobs, and manage your profile.`
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
