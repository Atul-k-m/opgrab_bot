import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not defined in .env file');
  process.exit(1);
}

const bot = new Telegraf(token);

// In-memory session storage for onboarding wizard
const sessions = new Map();

const STAGE = {
  NONE: 'NONE',
  AWAITING_BATCH: 'AWAITING_BATCH',
  AWAITING_SKILLS: 'AWAITING_SKILLS',
  AWAITING_CGPA: 'AWAITING_CGPA',
  COMPLETED: 'COMPLETED'
};

bot.use((ctx, next) => {
  console.log(`Update from ${ctx.from?.username || ctx.from?.id}: ${ctx.message?.text || ctx.callbackQuery?.data}`);
  return next();
});

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  sessions.set(chatId, { stage: STAGE.AWAITING_BATCH });
  
  ctx.reply('Welcome to OpportunityIQ! 🚀\nLet\'s set up your profile.\n\nPlease select your graduation batch year:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '2027 Batch', callback_data: 'batch_2027' }],
        [{ text: '2028 Batch', callback_data: 'batch_2028' }]
      ]
    }
  });
});

bot.command('cancel', (ctx) => {
  const chatId = ctx.chat.id;
  sessions.delete(chatId);
  ctx.reply('Onboarding cancelled. Send /start to begin again.');
});

bot.on('callback_query', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  const data = ctx.callbackQuery.data;

  if (!session) {
    return ctx.reply('Please send /start to begin.');
  }

  if (session.stage === STAGE.AWAITING_BATCH && data.startsWith('batch_')) {
    const year = data.split('_')[1];
    session.batch = year;
    session.stage = STAGE.AWAITING_SKILLS;
    
    await ctx.answerCbQuery();
    await ctx.reply(`Great! You selected ${year}.\n\nNow, please list your skills (comma separated, e.g., Python, React, AWS):`);
  }
});

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  const text = ctx.message.text;

  if (!session) {
    if (text.startsWith('/')) return;
    return ctx.reply('Send /start to begin profile setup.');
  }

  if (text === '/cancel') {
    sessions.delete(chatId);
    return ctx.reply('Onboarding cancelled.');
  }

  if (session.stage === STAGE.AWAITING_SKILLS) {
    const skills = text.split(',').map(s => s.trim()).filter(s => s);
    if (skills.length === 0) {
      return ctx.reply('Please enter at least one skill.');
    }
    session.skills = skills;
    session.stage = STAGE.AWAITING_CGPA;
    
    return ctx.reply('Skills saved! Now, please enter your CGPA (or send /skip):');
  }

  if (session.stage === STAGE.AWAITING_CGPA) {
    if (text === '/skip') {
      session.cgpa = null;
    } else {
      const cgpa = parseFloat(text);
      if (isNaN(cgpa) || cgpa < 0 || cgpa > 10) {
        return ctx.reply('Please enter a valid CGPA between 0 and 10 or /skip.');
      }
      session.cgpa = cgpa;
    }
    
    session.stage = STAGE.COMPLETED;
    
    // Save to Supabase
    try {
      // 1. Get or Create User
      let { data: user, error: userError } = await supabase
        .from('users')
        .select('id')
        .eq('telegram_id', chatId)
        .single();

      if (userError && userError.code === 'PGRST116') { // Edge case: record not found
        const { data: newUser, error: createError } = await supabase
          .from('users')
          .insert([{ telegram_id: chatId }])
          .select('id')
          .single();
          
        if (createError) throw createError;
        user = newUser;
      } else if (userError) {
        throw userError;
      }

      // 2. Upsert Profile
      const { error: profileError } = await supabase
        .from('profiles')
        .upsert([{
          user_id: user.id,
          skills: session.skills,
          batch_year: parseInt(session.batch),
          cgpa: session.cgpa
        }]);

      if (profileError) throw profileError;

      console.log(`Profile synced to Supabase for Telegram user ${chatId}`);
      
    } catch (err) {
      console.error('Database sync failed:', err.message);
      await ctx.reply('⚠️ Profile completed but failed to sync with the database. (Are your Supabase keys configured?)');
    }
    
    sessions.delete(chatId); // Clear session
    
    return ctx.reply(`Profile Complete! 🎉\n\nBatch: ${session.batch}\nSkills: ${session.skills.join(', ')}\nCGPA: ${session.cgpa || 'N/A'}\n\nYou are all set to receive digests!`);
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('🤖 OpportunityIQ Bot started in polling mode (with Supabase sync)...');
