import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';
import { rankOpportunities, generateDigest, expandSkills } from './matcher.js';

dotenv.config();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const sessions = new Map();
const pageState = new Map(); // chatId -> { items, page, type }

const STAGE = { AWAITING_BATCH: 1, AWAITING_SKILLS: 2, AWAITING_CGPA: 3 };
const PAGE_SIZE = 5;

// ─── Helpers ───
function esc(t) { return (t||'').replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1'); }

function formatOpp(opp, i, offset = 0) {
  const idx = offset + i + 1;
  const match = opp.relevancePct ? ` 🎯 ${opp.relevancePct}%` : '';
  const kws = opp.matchedKeywords?.length ? `\n   🏷 ${opp.matchedKeywords.slice(0,3).join(', ')}` : '';
  const dl = opp.deadline ? `\n   ⏰ ${new Date(opp.deadline).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}` : '';
  return `${idx}\\. *${esc(opp.title)}*${match}\n   🏢 ${esc(opp.company)} \\| ${esc(opp.source)}${kws}${dl}\n   [Open →](${opp.url})\n`;
}

function paginationKb(chatId) {
  const s = pageState.get(chatId);
  if (!s) return [];
  const total = Math.ceil(s.items.length / PAGE_SIZE);
  const btns = [];
  if (s.page > 0) btns.push(Markup.button.callback('◀ Prev', 'page_prev'));
  btns.push(Markup.button.callback(`${s.page+1}/${total}`, 'page_noop'));
  if (s.page < total - 1) btns.push(Markup.button.callback('Next ▶', 'page_next'));
  return btns.length > 1 ? [btns] : [];
}

async function getProfile(chatId) {
  const { data: user } = await supabase.from('users').select('id').eq('telegram_id', chatId).single();
  if (!user) return null;
  const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', user.id).single();
  return profile ? { ...profile, userId: user.id } : null;
}

async function getAllOpps() {
  const { data } = await supabase.from('opportunities')
    .select('title, company, url, source, deadline, created_at')
    .order('created_at', { ascending: false }).limit(500);
  return data || [];
}

async function sendPage(ctx, chatId, header) {
  const s = pageState.get(chatId);
  if (!s) return;
  const start = s.page * PAGE_SIZE;
  const slice = s.items.slice(start, start + PAGE_SIZE);
  let msg = header + '\n\n';
  slice.forEach((o, i) => { msg += formatOpp(o, i, start) + '\n'; });
  msg += `\n_Showing ${start+1}\\-${start+slice.length} of ${s.items.length}_`;
  const kb = paginationKb(chatId);
  await ctx.reply(msg, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(kb) });
}

// ─── Middleware ───
bot.use((ctx, next) => {
  console.log(`[${ctx.from?.username || ctx.from?.id}] ${ctx.message?.text || ctx.callbackQuery?.data || ''}`);
  return next();
});

// ─── /start ───
bot.start(ctx => {
  sessions.set(ctx.chat.id, { stage: STAGE.AWAITING_BATCH });
  ctx.reply('Welcome to *OpportunityIQ* ⚡\n\nLet\'s build your profile so I can find relevant opportunities for you\\.\n\nSelect your graduation batch:', {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🎓 2025', 'batch_2025'), Markup.button.callback('🎓 2026', 'batch_2026')],
      [Markup.button.callback('🎓 2027', 'batch_2027'), Markup.button.callback('🎓 2028', 'batch_2028')]
    ])
  });
});

// ─── /help ───
bot.command('help', ctx => {
  ctx.reply(
`⚡ *OpportunityIQ Commands*

🔍 *Discovery*
/foryou — AI\\-matched opportunities for your profile
/internships — Intern roles matched to your skills
/hackathons — Hackathons with relevance scoring
/search \\<keyword\\> — Search by keyword
/searchinterns \\<keyword\\> — Search internships by keyword
/searchhackathons \\<keyword\\> — Search hackathons by keyword

📬 *Intelligence*  
/digest — Full AI digest \\(matches, deadlines, trends\\)
/trending — Trending skills in the market

👤 *Profile*
/profile — View your profile
/start — Setup or update profile

📊 *Info*
/stats — Database statistics
/sources — Data source info`, { parse_mode: 'MarkdownV2' });
});

// ─── /foryou — AI-matched opportunities ───
bot.command('foryou', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  if (!profile?.skills?.length) return ctx.reply('Set up your profile first → /start');
  
  const opps = await getAllOpps();
  const ranked = rankOpportunities(opps, profile.skills, { limit: 50, minScore: 1 });
  
  if (!ranked.length) return ctx.reply('No strong matches found yet. Try updating your skills with /start');
  
  pageState.set(ctx.chat.id, { items: ranked, page: 0, type: 'foryou' });
  await sendPage(ctx, ctx.chat.id, `🎯 *Opportunities For You*\nBased on: ${profile.skills.slice(0,5).map(s=>esc(s)).join(', ')}`);
});

// ─── /internships — Filtered intern roles ───
bot.command('internships', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  const opps = await getAllOpps();
  
  // Filter to internship sources
  const internOpps = opps.filter(o => ['Internshala', 'Greenhouse'].includes(o.source));
  
  let ranked;
  if (profile?.skills?.length) {
    ranked = rankOpportunities(internOpps, profile.skills, { limit: 50, minScore: 0 });
  } else {
    ranked = internOpps.slice(0, 50).map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));
  }
  
  if (!ranked.length) return ctx.reply('No internships found. Run the scraper first!');
  
  pageState.set(ctx.chat.id, { items: ranked, page: 0, type: 'internships' });
  
  const header = profile?.skills?.length
    ? `💼 *Internships For You*\nRanked by relevance to: ${profile.skills.slice(0,4).map(s=>esc(s)).join(', ')}`
    : `💼 *Latest Internships*\nSet up your profile with /start for personalized ranking`;
  
  await sendPage(ctx, ctx.chat.id, header);
});

// ─── /hackathons ───
bot.command('hackathons', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  const opps = await getAllOpps();
  const hackOpps = opps.filter(o => ['Devfolio', 'Devpost'].includes(o.source));
  
  let ranked;
  if (profile?.skills?.length) {
    ranked = rankOpportunities(hackOpps, profile.skills, { limit: 50, minScore: 0 });
  } else {
    ranked = hackOpps.slice(0, 50).map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));
  }
  
  if (!ranked.length) return ctx.reply('No hackathons found.');
  
  pageState.set(ctx.chat.id, { items: ranked, page: 0, type: 'hackathons' });
  await sendPage(ctx, ctx.chat.id, '🏆 *Hackathons*');
});

// ─── /search <keyword> ───
bot.command('search', async ctx => {
  const kw = ctx.message.text.replace('/search', '').trim();
  if (!kw) return ctx.reply('Usage: /search python\n/search web development\n/search machine learning');
  
  const opps = await getAllOpps();
  const kwLow = kw.toLowerCase();
  const results = opps.filter(o => `${o.title} ${o.company}`.toLowerCase().includes(kwLow))
    .map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));
  
  if (!results.length) return ctx.reply(`No results for "${kw}". Try a different keyword.`);
  
  pageState.set(ctx.chat.id, { items: results, page: 0, type: 'search' });
  await sendPage(ctx, ctx.chat.id, `🔍 *Search: "${esc(kw)}"*\nFound ${results.length} results`);
});

// ─── /searchinterns <keyword> ───
bot.command('searchinterns', async ctx => {
  const kw = ctx.message.text.replace('/searchinterns', '').trim();
  if (!kw) return ctx.reply('Usage: /searchinterns <keyword>\nExample: /searchinterns software');
  
  const opps = await getAllOpps();
  const kwLow = kw.toLowerCase();
  const results = opps.filter(o => ['Internshala', 'Greenhouse'].includes(o.source) && `${o.title} ${o.company}`.toLowerCase().includes(kwLow))
    .map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));
  
  if (!results.length) return ctx.reply(`No internship results for "${kw}".`);
  
  pageState.set(ctx.chat.id, { items: results, page: 0, type: 'searchinterns' });
  await sendPage(ctx, ctx.chat.id, `💼 *Internship Search: "${esc(kw)}"*\nFound ${results.length} results`);
});

// ─── /searchhackathons <keyword> ───
bot.command('searchhackathons', async ctx => {
  const kw = ctx.message.text.replace('/searchhackathons', '').trim();
  if (!kw) return ctx.reply('Usage: /searchhackathons <keyword>\nExample: /searchhackathons web3');
  
  const opps = await getAllOpps();
  const kwLow = kw.toLowerCase();
  const results = opps.filter(o => ['Devfolio', 'Devpost'].includes(o.source) && `${o.title} ${o.company}`.toLowerCase().includes(kwLow))
    .map(o => ({ ...o, relevancePct: 0, matchedKeywords: [], score: 0 }));
  
  if (!results.length) return ctx.reply(`No hackathon results for "${kw}".`);
  
  pageState.set(ctx.chat.id, { items: results, page: 0, type: 'searchhackathons' });
  await sendPage(ctx, ctx.chat.id, `🏆 *Hackathon Search: "${esc(kw)}"*\nFound ${results.length} results`);
});

// ─── /digest — Rich AI Digest ───
bot.command('digest', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  if (!profile?.skills?.length) return ctx.reply('Set up your profile first → /start');
  
  const opps = await getAllOpps();
  const digest = generateDigest(opps, profile);
  
  let msg = `📬 *Your AI Digest*\n`;
  msg += `━━━━━━━━━━━━━━━\n\n`;
  
  // Profile strength
  const strengthEmoji = { strong: '🟢', moderate: '🟡', weak: '🔴' };
  msg += `${strengthEmoji[digest.profileStrength]} Profile: ${esc(digest.profileStrength)} \\| ${digest.totalOpps} total opps\n\n`;
  
  // Top matches
  if (digest.topMatches.length) {
    msg += `🎯 *Top Matches*\n`;
    digest.topMatches.forEach((o, i) => { msg += formatOpp(o, i) + '\n'; });
  } else {
    msg += `⚠️ No strong matches\\. Consider broadening your skills\\.\n\n`;
  }
  
  // Expiring soon
  if (digest.expiringSoon.length) {
    msg += `\n⏰ *Expiring This Week*\n`;
    digest.expiringSoon.forEach(o => {
      const days = Math.ceil((new Date(o.deadline) - new Date()) / 86400000);
      msg += `  • ${esc(o.title)} \\(${days}d left\\)\n`;
    });
    msg += '\n';
  }
  
  // Trending skills user doesn't have
  if (digest.trendingSkills.length) {
    msg += `📈 *Trending Skills You Could Add*\n`;
    digest.trendingSkills.forEach(s => {
      msg += `  • ${esc(s.skill)} \\(${s.count} recent opps\\)\n`;
    });
    msg += '\n';
  }
  
  // New today
  if (digest.newOpps.length) {
    msg += `🆕 *New Today:* ${digest.newOpps.length} opportunities added\n`;
  }
  
  msg += `\n_Use /foryou for full ranked list_`;
  
  await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
});

// ─── /trending ───
bot.command('trending', async ctx => {
  const opps = await getAllOpps();
  const freq = {};
  const keywords = ['python','javascript','react','data','design','marketing','sales','ml','ai','cloud','devops','hr','finance','content','mobile','java','golang','rust','security','full stack'];
  
  for (const o of opps.slice(0, 200)) {
    const t = `${o.title} ${o.company}`.toLowerCase();
    for (const kw of keywords) {
      if (t.includes(kw)) freq[kw] = (freq[kw] || 0) + 1;
    }
  }
  
  const sorted = Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, 10);
  if (!sorted.length) return ctx.reply('Not enough data for trends yet.');
  
  let msg = '📈 *Trending Skills in Opportunities*\n\n';
  const max = sorted[0][1];
  sorted.forEach(([skill, count], i) => {
    const bar = '█'.repeat(Math.ceil((count/max)*10));
    msg += `${i+1}\\. *${esc(skill)}* — ${count} opps ${esc(bar)}\n`;
  });
  msg += '\n_Based on latest 200 opportunities_';
  
  await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
});

// ─── /profile ───
bot.command('profile', async ctx => {
  const profile = await getProfile(ctx.chat.id);
  if (!profile) return ctx.reply('No profile yet. Send /start to create one!');
  
  const expanded = expandSkills(profile.skills || []);
  const coverageCount = expanded.size;
  
  await ctx.reply(
`👤 *Your Profile*

📅 Batch: ${profile.batch_year || 'N/A'}
💡 Skills: ${(profile.skills||[]).map(s=>esc(s)).join(', ') || 'None'}
📊 CGPA: ${profile.cgpa || 'N/A'}

🧠 *AI Coverage:* ${coverageCount} related keywords tracked
This means I search for ${coverageCount} variations of your skills when matching\\.

_Send /start to update\\._`, { parse_mode: 'MarkdownV2' });
});

// ─── /stats ───
bot.command('stats', async ctx => {
  const opps = await getAllOpps();
  const src = {};
  opps.forEach(o => { src[o.source] = (src[o.source]||0)+1; });
  
  let msg = `📊 *OpportunityIQ Stats*\n\n📋 Total: ${opps.length}\n\n`;
  for (const [s, c] of Object.entries(src).sort((a,b)=>b[1]-a[1])) {
    msg += `${esc(s)}: ${c}\n`;
  }
  await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
});

// ─── /sources ───
bot.command('sources', ctx => {
  ctx.reply(
`🌐 *Data Sources*

🔵 *Devfolio* — Indian hackathons
🟣 *Devpost* — Global hackathons \\(API\\)
🟠 *Internshala* — Internships in India \\(3 pages\\)
🟢 *Greenhouse* — Top tech cos \\(Airbnb, Figma, Lyft, etc\\.\\)

Run scraper: \`node src/scraper\\.js\``, { parse_mode: 'MarkdownV2' });
});

// ─── Pagination Callbacks ───
bot.action('page_prev', async ctx => {
  const s = pageState.get(ctx.chat.id);
  if (s && s.page > 0) { s.page--; await sendPage(ctx, ctx.chat.id, `Page ${s.page+1}`); }
  await ctx.answerCbQuery();
});
bot.action('page_next', async ctx => {
  const s = pageState.get(ctx.chat.id);
  const total = s ? Math.ceil(s.items.length / PAGE_SIZE) : 0;
  if (s && s.page < total - 1) { s.page++; await sendPage(ctx, ctx.chat.id, `Page ${s.page+1}`); }
  await ctx.answerCbQuery();
});
bot.action('page_noop', ctx => ctx.answerCbQuery());

// ─── Batch Selection Callback ───
bot.action(/^batch_(.+)$/, async ctx => {
  const session = sessions.get(ctx.chat.id);
  if (!session || session.stage !== STAGE.AWAITING_BATCH) return ctx.answerCbQuery();
  session.batch = ctx.match[1];
  session.stage = STAGE.AWAITING_SKILLS;
  await ctx.answerCbQuery();
  await ctx.reply(`✅ Batch ${session.batch}\n\nNow list your skills (comma separated):\ne.g. Python, React, Machine Learning, Data Science`);
});

// ─── Text Handler (Onboarding) ───
bot.on('text', async ctx => {
  const session = sessions.get(ctx.chat.id);
  const text = ctx.message.text;
  if (!session) {
    if (!text.startsWith('/')) ctx.reply('Send /help for available commands.');
    return;
  }
  
  if (session.stage === STAGE.AWAITING_SKILLS) {
    const skills = text.split(',').map(s => s.trim()).filter(Boolean);
    if (!skills.length) return ctx.reply('Enter at least one skill.');
    session.skills = skills;
    session.stage = STAGE.AWAITING_CGPA;
    
    const expanded = expandSkills(skills);
    return ctx.reply(`✅ Got ${skills.length} skills → AI will track ${expanded.size} related keywords\n\nEnter your CGPA (0-10) or /skip:`);
  }
  
  if (session.stage === STAGE.AWAITING_CGPA) {
    const cgpa = text === '/skip' ? null : parseFloat(text);
    if (text !== '/skip' && (isNaN(cgpa) || cgpa < 0 || cgpa > 10)) return ctx.reply('Enter 0-10 or /skip');
    
    try {
      let { data: user } = await supabase.from('users').select('id').eq('telegram_id', ctx.chat.id).single();
      if (!user) {
        const { data: nu, error } = await supabase.from('users').insert([{ telegram_id: ctx.chat.id }]).select('id').single();
        if (error) throw error;
        user = nu;
      }
      await supabase.from('profiles').upsert([{
        user_id: user.id, skills: session.skills,
        batch_year: parseInt(session.batch), cgpa
      }]);
      
      sessions.delete(ctx.chat.id);
      ctx.reply(`🎉 Profile complete!\n\n📅 Batch: ${session.batch}\n💡 Skills: ${session.skills.join(', ')}\n📊 CGPA: ${cgpa || 'N/A'}\n\nTry these:\n/foryou — AI-matched opportunities\n/digest — Your full intelligence report\n/internships — Relevant internships`);
    } catch (err) {
      console.error('DB error:', err.message);
      ctx.reply('⚠️ Saved locally but DB sync failed.');
      sessions.delete(ctx.chat.id);
    }
  }
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
console.log('⚡ OpportunityIQ Bot started (with AI matching)...');
