/**
 * bot.js — OpportunityIQ Telegram Bot
 *
 * - Auto-scrapes every 6 hours (no manual trigger needed)
 * - AI-powered matching via Gemini (with local fallback)
 * - India/remote-aware filtering by default
 * - Proper role exclusion (no PhD, senior, director roles)
 */

import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();
console.log('GROQ KEY:', process.env.GROQ_API_KEY?.slice(0, 8));
import { supabase } from './supabase.js';
import { rankOpportunities, generateDigest, expandSkills, isExcluded } from './matcher.js';
import { runScraper } from './scraper.js';


const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const sessions = new Map();      // chatId -> onboarding session
const pageState = new Map();     // chatId -> { items, page }

const STAGE = { AWAITING_BATCH: 1, AWAITING_DOMAINS: 2, AWAITING_SKILLS: 3, AWAITING_CGPA: 4 };
const PAGE_SIZE = 5;

// ─── Markdown Escape ───
function esc(t) {
  return (t || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ─── Format one opportunity card ───
function formatOpp(opp, i, offset = 0) {
  const idx = offset + i + 1;
  const pct = opp.relevancePct ? ` 🎯 ${opp.relevancePct}%` : '';
  const aiTag = opp.scoredByAI ? ' ✨' : '';
  const reason = opp.reason ? `\n   💬 ${esc(opp.reason.slice(0, 80))}` : '';
  const loc = opp.location ? `\n   📍 ${esc(opp.location)}` : '';
  const dl = opp.deadline
    ? `\n   ⏰ ${new Date(opp.deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : '';
  return `${idx}\\. *${esc(opp.title)}*${pct}${aiTag}\n   🏢 ${esc(opp.company)} \\| ${esc(opp.source)}${loc}${reason}${dl}\n   [Apply →](${opp.url})\n`;
}

// ─── Pagination keyboard ───
function paginationKb(chatId) {
  const s = pageState.get(chatId);
  if (!s) return [];
  const total = Math.ceil(s.items.length / PAGE_SIZE);
  const btns = [];
  if (s.page > 0) btns.push(Markup.button.callback('◀ Prev', 'page_prev'));
  btns.push(Markup.button.callback(`${s.page + 1}/${total}`, 'page_noop'));
  if (s.page < total - 1) btns.push(Markup.button.callback('Next ▶', 'page_next'));
  return btns.length > 1 ? [btns] : [];
}

// ─── Get user profile from DB ───
async function getProfile(chatId) {
  const { data: user } = await supabase.from('users').select('id').eq('telegram_id', chatId).single();
  if (!user) return null;
  const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', user.id).single();
  return profile ? { ...profile, userId: user.id } : null;
}

// ─── Fetch all opportunities (latest 500) ───
async function getAllOpps() {
  const { data } = await supabase
    .from('opportunities')
    .select('id, title, company, url, source, deadline, location, tags, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  return (data || []).filter(o => !isExcluded(o.title));
}

// ─── Send paginated results ───
async function sendPage(ctx, chatId, header) {
  const s = pageState.get(chatId);
  if (!s || !s.items.length) {
    await ctx.reply('No results to display.');
    return;
  }
  const start = s.page * PAGE_SIZE;
  const slice = s.items.slice(start, start + PAGE_SIZE);
  let msg = header + '\n\n';
  slice.forEach((o, i) => { msg += formatOpp(o, i, start) + '\n'; });
  msg += `\n_Showing ${start + 1}\\-${start + slice.length} of ${s.items.length}_`;
  const kb = paginationKb(chatId);
  try {
    await ctx.reply(msg, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(kb) });
  } catch (err) {
    // Fallback plain text if MarkdownV2 fails
    await ctx.reply(`Results: ${s.items.length} found. First result: ${slice[0]?.title} at ${slice[0]?.url}`);
  }
}

// ─── Loading indicator ───
async function sendLoading(ctx, message = '⏳ Fetching and scoring opportunities\\.\\.\\. this may take a moment') {
  return ctx.reply(message, { parse_mode: 'MarkdownV2' });
}


// ═══════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════

// /start — Onboarding
bot.start(ctx => {
  sessions.set(ctx.chat.id, { stage: STAGE.AWAITING_BATCH });
  ctx.reply(
    'Welcome to *OpportunityIQ* ⚡\n\nI find real opportunities \\(internships, hackathons, jobs\\) relevant to *you* \\— only India\\-accessible or remote roles\\.\n\nFirst, select your graduation batch:',
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎓 2025', 'batch_2025'), Markup.button.callback('🎓 2026', 'batch_2026')],
        [Markup.button.callback('🎓 2027', 'batch_2027'), Markup.button.callback('🎓 2028', 'batch_2028')],
      ]),
    }
  );
});

// /help
bot.command('help', ctx => {
  ctx.reply(
    `⚡ *OpportunityIQ Commands*\n\n` +
    `🔍 *Discovery*\n` +
    `/foryou — AI\\-matched opportunities for you\n` +
    `/internships — Internships \\(India \\+ remote\\)\n` +
    `/hackathons — Hackathons worldwide\n` +
    `/jobs — Entry\\-level jobs \\(remote\\)\n` +
    `/search \\<keyword\\> — Search all sources\n\n` +
    `📬 *Intelligence*\n` +
    `/digest — Full AI digest with insights\n` +
    `/trending — Trending skills in postings\n\n` +
    `👤 *Profile*\n` +
    `/profile — View your profile\n` +
    `/start — Setup or update profile\n\n` +
    `📊 *Info*\n` +
    `/stats — Live database stats\n` +
    `/refresh — Manually trigger a scrape`,
    { parse_mode: 'MarkdownV2' }
  );
});

// /foryou — AI-matched opportunities
bot.command('foryou', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  if (!profile?.skills?.length) {
    return ctx.reply('Set up your profile first → /start');
  }

  await sendLoading(ctx);
  const opps = await getAllOpps();

  if (!opps.length) return ctx.reply('No opportunities in DB yet\\. Try /refresh\\.', { parse_mode: 'MarkdownV2' });

  const ranked = await rankOpportunities(opps, profile.skills, profile, { limit: 50, minScore: 5 });

  if (!ranked.length) {
    return ctx.reply('No strong matches found\\. Try updating your skills with /start or use /search\\.', { parse_mode: 'MarkdownV2' });
  }

  pageState.set(ctx.chat.id, { items: ranked, page: 0 });
  const aiLabel = ranked[0]?.scoredByAI ? ' ✨ AI\\-scored' : '';
  await sendPage(
    ctx, ctx.chat.id,
    `🎯 *For You*${aiLabel}\nBased on: ${profile.skills.slice(0, 4).map(s => esc(s)).join(', ')}`
  );
});

// /internships — India-relevant internships
bot.command('internships', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  const opps = await getAllOpps();

  // Filter to intern-specific sources + any title containing intern keywords
  const internOpps = opps.filter(o => {
    const t = o.title.toLowerCase();
    return (
      ['Internshala', 'Unstop'].includes(o.source) ||
      ['intern', 'internship', 'trainee', 'apprentice'].some(kw => t.includes(kw))
    );
  });

  if (!internOpps.length) return ctx.reply('No internships found\\. Run /refresh first\\.', { parse_mode: 'MarkdownV2' });

  let ranked;
  if (profile?.skills?.length) {
    await sendLoading(ctx);
    ranked = await rankOpportunities(internOpps, profile.skills, profile, { limit: 50, minScore: 0 });
  } else {
    ranked = internOpps.slice(0, 50).map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));
  }

  pageState.set(ctx.chat.id, { items: ranked, page: 0 });
  const header = profile?.skills?.length
    ? `💼 *Internships For You*\nRanked by relevance to: ${profile.skills.slice(0, 3).map(s => esc(s)).join(', ')}`
    : `💼 *Latest Internships*\nSet up your profile with /start for personalized ranking`;

  await sendPage(ctx, ctx.chat.id, header);
});

// /hackathons
bot.command('hackathons', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  const opps = await getAllOpps();
  const hackOpps = opps.filter(o => ['Devfolio', 'Devpost'].includes(o.source));

  if (!hackOpps.length) return ctx.reply('No hackathons found\\. Run /refresh first\\.', { parse_mode: 'MarkdownV2' });

  let ranked;
  if (profile?.skills?.length) {
    ranked = await rankOpportunities(hackOpps, profile.skills, profile, { limit: 50, minScore: 0 });
  } else {
    ranked = hackOpps.slice(0, 50).map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));
  }

  pageState.set(ctx.chat.id, { items: ranked, page: 0 });
  await sendPage(ctx, ctx.chat.id, '🏆 *Hackathons*');
});

// /jobs — Entry-level remote jobs
bot.command('jobs', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  const opps = await getAllOpps();

  // Jobs from remote-first sources
  const jobOpps = opps.filter(o => {
    const t = o.title.toLowerCase();
    const isJobSource = ['Remotive', 'Arbeitnow', 'TheMuse', 'Unstop'].includes(o.source);
    const isEntryLevel = ['junior', 'entry', 'associate', 'graduate', 'new grad', 'fresher'].some(kw => t.includes(kw));
    return isJobSource && (isEntryLevel || !t.includes('senior'));
  });

  if (!jobOpps.length) return ctx.reply('No jobs found\\. Run /refresh first\\.', { parse_mode: 'MarkdownV2' });

  let ranked;
  if (profile?.skills?.length) {
    await sendLoading(ctx);
    ranked = await rankOpportunities(jobOpps, profile.skills, profile, { limit: 50, minScore: 0 });
  } else {
    ranked = jobOpps.slice(0, 50).map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));
  }

  pageState.set(ctx.chat.id, { items: ranked, page: 0 });
  const header = profile?.skills?.length
    ? `💼 *Entry\\-Level Jobs*\nRanked by match to: ${profile.skills.slice(0, 3).map(s => esc(s)).join(', ')}`
    : `💼 *Entry\\-Level Remote Jobs*\nSetup profile with /start for personalized ranking`;

  await sendPage(ctx, ctx.chat.id, header);
});

// /search <keyword>
bot.command('search', async ctx => {
  const kw = ctx.message.text.replace('/search', '').trim();
  if (!kw) return ctx.reply('Usage: /search python\n/search web development\n/search machine learning');

  const opps = await getAllOpps();
  const kwLow = kw.toLowerCase();
  const results = opps
    .filter(o => `${o.title} ${o.company} ${(o.tags || []).join(' ')}`.toLowerCase().includes(kwLow))
    .map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));

  if (!results.length) return ctx.reply(`No results for "${kw}". Try a different keyword or run /refresh`);

  pageState.set(ctx.chat.id, { items: results, page: 0 });
  await sendPage(ctx, ctx.chat.id, `🔍 *Search: "${esc(kw)}"*\nFound ${results.length} results`);
});

// /digest — Full AI digest
bot.command('digest', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  if (!profile?.skills?.length) return ctx.reply('Set up your profile first → /start');

  await sendLoading(ctx, '⏳ Generating your AI digest\\.\\.\\.');
  const opps = await getAllOpps();
  const digest = await generateDigest(opps, profile);

  const strengthEmoji = { strong: '🟢', moderate: '🟡', weak: '🔴' };
  const aiLabel = digest.aiPowered ? '✨ AI\\-Powered' : '⚙️ Local';

  let msg = `📬 *Your Digest* \\[${aiLabel}\\]\n━━━━━━━━━━━━━━━\n\n`;
  msg += `${strengthEmoji[digest.profileStrength]} Profile: ${esc(digest.profileStrength)} \\| ${digest.totalOpps} opportunities indexed\n\n`;

  if (digest.topMatches.length) {
    msg += `🎯 *Top Matches*\n`;
    digest.topMatches.forEach((o, i) => { msg += formatOpp(o, i) + '\n'; });
  } else {
    msg += `⚠️ No strong matches\\. Try broadening your skills\\.\n\n`;
  }

  if (digest.expiringSoon.length) {
    msg += `\n⏰ *Expiring This Week*\n`;
    digest.expiringSoon.forEach(o => {
      const days = Math.ceil(o.daysLeft);
      msg += `  • ${esc(o.title)} \\(${days}d left\\)\n`;
    });
    msg += '\n';
  }

  if (digest.newOpps.length) {
    msg += `🆕 *Added Today:* ${digest.newOpps.length} new opportunities\n`;
  }

  const breakdown = Object.entries(digest.sourceBreakdown).sort((a, b) => b[1] - a[1]);
  if (breakdown.length) {
    msg += `\n📊 *Sources:*\n`;
    breakdown.forEach(([src, cnt]) => { msg += `  ${esc(src)}: ${cnt}\n`; });
  }

  msg += `\n_Use /foryou for full ranked list_`;

  try {
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch {
    await ctx.reply(`Digest ready! Top match: ${digest.topMatches[0]?.title || 'None'}`);
  }
});

// /trending — Trending skills in current opportunities
bot.command('trending', async ctx => {
  const opps = await getAllOpps();
  const freq = {};
  const keywords = [
    'python', 'javascript', 'react', 'typescript', 'data science', 'machine learning',
    'golang', 'rust', 'java', 'kotlin', 'flutter', 'devops', 'cloud', 'aws',
    'docker', 'kubernetes', 'sql', 'design', 'figma', 'marketing', 'content',
    'cybersecurity', 'blockchain', 'web3', 'mobile', 'android', 'ios', 'next',
  ];

  for (const o of opps.slice(0, 300)) {
    const t = `${o.title} ${o.company} ${(o.tags || []).join(' ')}`.toLowerCase();
    for (const kw of keywords) {
      if (t.includes(kw)) freq[kw] = (freq[kw] || 0) + 1;
    }
  }

  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (!sorted.length) return ctx.reply('Not enough data yet. Run /refresh first.');

  const max = sorted[0][1];
  let msg = '📈 *Trending Skills in Current Postings*\n\n';
  sorted.forEach(([skill, count], i) => {
    const bar = '█'.repeat(Math.ceil((count / max) * 8));
    msg += `${i + 1}\\. *${esc(skill)}* — ${count} postings ${esc(bar)}\n`;
  });
  msg += '\n_Based on latest 300 opportunities_';

  await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
});

// /profile
bot.command('profile', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  if (!profile) return ctx.reply('No profile yet\\. Send /start to create one\\!', { parse_mode: 'MarkdownV2' });

  const expanded = expandSkills(profile.skills || []);
  await ctx.reply(
    `👤 *Your Profile*\n\n` +
    `📅 Batch: ${esc(String(profile.batch_year || 'N/A'))}\n` +
    `💡 Domains \\& Skills: ${(profile.skills || []).map(s => esc(s)).join(', ') || 'None set'}\n` +
    `📊 CGPA: ${esc(String(profile.cgpa || 'N/A'))}\n\n` +
    `🧠 *Coverage:* ${expanded.size} related keywords tracked by AI\n\n` +
    `_Send /start to update profile_`,
    { parse_mode: 'MarkdownV2' }
  );
});

// /stats — DB stats
bot.command('stats', async ctx => {
  const opps = await getAllOpps();
  const src = {};
  opps.forEach(o => { src[o.source] = (src[o.source] || 0) + 1; });

  let msg = `📊 *OpportunityIQ Stats*\n\n📋 Total \\(after filter\\): ${opps.length}\n\n`;
  for (const [s, c] of Object.entries(src).sort((a, b) => b[1] - a[1])) {
    msg += `${esc(s)}: ${c}\n`;
  }
  msg += `\n_All PhD/senior roles excluded_`;
  await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
});

// /refresh — Manually trigger scraper
bot.command('refresh', async ctx => {
  await ctx.reply('🔄 Starting manual scrape\\.\\.\\. this takes 1\\-2 minutes\\.', { parse_mode: 'MarkdownV2' });
  try {
    const result = await runScraper();
    await ctx.reply(
      `✅ *Scrape Complete*\n\n` +
      `📥 Synced: ${result.synced} opportunities\n` +
      `⏭ Skipped \\(dupes\\): ${result.skipped}\n` +
      `📦 Total unique: ${result.total}\n\n` +
      `Try /foryou or /internships now\\!`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    await ctx.reply(`❌ Scrape failed: ${err.message}`);
  }
});

// /sources — Data sources info
bot.command('sources', ctx => {
  ctx.reply(
    `🌐 *Data Sources \\(all dynamic\\)*\n\n` +
    `🟠 *Internshala* — India internships \\(14 categories\\)\n` +
    `🔵 *Unstop* — India competitions \\& jobs\n` +
    `🟣 *Devfolio* — Indian hackathons\n` +
    `🟤 *Devpost* — Global hackathons \\(API\\)\n` +
    `🟢 *Remotive* — Remote tech jobs \\(API, no key\\)\n` +
    `⚫ *Arbeitnow* — Remote global jobs \\(API, no key\\)\n` +
    `🔴 *The Muse* — Startup entry\\-level jobs \\(API\\)\n` +
    `🔷 *LinkedIn* — India intern/entry roles \\(public search\\)\n\n` +
    `_No hardcoded company lists\\. All dynamically discovered\\._`,
    { parse_mode: 'MarkdownV2' }
  );
});


// ═══════════════════════════════════════════════════════════
// PAGINATION CALLBACKS
// ═══════════════════════════════════════════════════════════
bot.action('page_prev', async ctx => {
  const s = pageState.get(ctx.chat.id);
  if (s && s.page > 0) { s.page--; await sendPage(ctx, ctx.chat.id, `📄 Page ${s.page + 1}`); }
  await ctx.answerCbQuery();
});
bot.action('page_next', async ctx => {
  const s = pageState.get(ctx.chat.id);
  const total = s ? Math.ceil(s.items.length / PAGE_SIZE) : 0;
  if (s && s.page < total - 1) { s.page++; await sendPage(ctx, ctx.chat.id, `📄 Page ${s.page + 1}`); }
  await ctx.answerCbQuery();
});
bot.action('page_noop', ctx => ctx.answerCbQuery());


// ═══════════════════════════════════════════════════════════
// ONBOARDING CALLBACKS
// ═══════════════════════════════════════════════════════════
bot.action(/^batch_(.+)$/, async ctx => {
  const session = sessions.get(ctx.chat.id);
  if (!session || session.stage !== STAGE.AWAITING_BATCH) return ctx.answerCbQuery();
  session.batch = ctx.match[1];
  session.stage = STAGE.AWAITING_DOMAINS;
  await ctx.answerCbQuery();
  await ctx.reply(
    `✅ Batch *${session.batch}* noted\\.\n\nNow, what are your preferred *domains*? \\(comma separated\\):\n_e\\.g\\. Web Development, Data Science, Product Management, Design_`,
    { parse_mode: 'MarkdownV2' }
  );
});


// ═══════════════════════════════════════════════════════════
// TEXT HANDLER (Onboarding flow)
// ═══════════════════════════════════════════════════════════
bot.on('text', async ctx => {
  const session = sessions.get(ctx.chat.id);
  const text = ctx.message.text;

  if (!session) {
    if (!text.startsWith('/')) ctx.reply('Send /help for available commands.');
    return;
  }

  if (session.stage === STAGE.AWAITING_DOMAINS) {
    const domains = text.split(',').map(s => s.trim()).filter(Boolean);
    if (!domains.length) return ctx.reply('Enter at least one domain.');
    session.domains = domains;
    session.stage = STAGE.AWAITING_SKILLS;
    return ctx.reply(
      `✅ Got ${domains.length} domains\\.\n\nNext, list your core *skills* \\(comma separated\\):\n_e\\.g\\. Python, React, Machine Learning, Figma_`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  if (session.stage === STAGE.AWAITING_SKILLS) {
    const skills = text.split(',').map(s => s.trim()).filter(Boolean);
    if (!skills.length) return ctx.reply('Enter at least one skill.');
    // Combine domains and skills for broader matching
    session.skills = [...new Set([...session.domains, ...skills])];
    session.stage = STAGE.AWAITING_CGPA;
    const expanded = expandSkills(session.skills);
    return ctx.reply(
      `✅ Got ${skills.length} skills → tracking ${expanded.size} related keywords \\(including domains\\)\n\nFinally, enter your *CGPA* \\(0\\-10\\) or type /skip:`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  if (session.stage === STAGE.AWAITING_CGPA) {
    const cgpa = text === '/skip' ? null : parseFloat(text);
    if (text !== '/skip' && (isNaN(cgpa) || cgpa < 0 || cgpa > 10)) {
      return ctx.reply('Enter a value between 0 and 10, or /skip');
    }

    try {
      let { data: user } = await supabase.from('users').select('id').eq('telegram_id', ctx.chat.id).single();
      if (!user) {
        const { data: nu, error } = await supabase.from('users').insert([{ telegram_id: ctx.chat.id }]).select('id').single();
        if (error) throw error;
        user = nu;
      }

      await supabase.from('profiles').upsert([{
        user_id: user.id,
        skills: session.skills,
        batch_year: parseInt(session.batch),
        cgpa,
      }]);

      sessions.delete(ctx.chat.id);
      await ctx.reply(
        `🎉 *Profile complete\\!*\n\n` +
        `📅 Batch: ${session.batch}\n` +
        `💡 Interests: ${session.skills.join(', ')}\n` +
        `📊 CGPA: ${cgpa || 'N/A'}\n\n` +
        `Try:\n` +
        `/foryou — AI\\-matched opportunities\n` +
        `/internships — India internships\n` +
        `/jobs — Remote entry\\-level jobs\n` +
        `/digest — Full intelligence report`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (err) {
      console.error('DB error:', err.message);
      sessions.delete(ctx.chat.id);
      ctx.reply('⚠️ Profile saved locally but DB sync failed. Try /start again.');
    }
  }
});


// ═══════════════════════════════════════════════════════════
// AUTO SCRAPER — runs via node-cron
// ═══════════════════════════════════════════════════════════
import cron from 'node-cron';

async function scheduledScrape() {
  console.log('\n⏰ Scheduled cron scrape triggered...');
  try {
    await runScraper();
    console.log('✅ Scheduled scrape complete.');
  } catch (err) {
    console.error('❌ Scheduled scrape failed:', err.message);
  }
}

// Run once at startup, then every 6 hours using cron
setTimeout(scheduledScrape, 5000); // 5 sec delay on startup
cron.schedule('0 */6 * * *', scheduledScrape, {
  scheduled: true,
  timezone: "Asia/Kolkata" // explicitly setting to IST
});


// ═══════════════════════════════════════════════════════════
// LAUNCH & HEALTH CHECK SERVER (For 24/7 Uptime)
// ═══════════════════════════════════════════════════════════
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/ping', (req, res) => {
  res.send('OpportunityIQ Bot is alive and well! 🤖⚡');
});

app.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
  
  // Launch Bot after server starts
  bot.launch();
  console.log('⚡ OpportunityIQ Bot started — auto-scraping via cron');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
