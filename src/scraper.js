import crypto from 'crypto';
import { supabase } from './supabase.js';

// Mock function to simulate scraping
async function scrapeSource(sourceName) {
  console.log(`\n🔍 Scraping source: ${sourceName}...`);
  
  if (sourceName === 'Devfolio') {
    return [
      {
        title: 'Build-a-Thon 2026',
        company: 'Devfolio',
        deadline: '2026-06-15T18:30:00Z',
        url: 'https://devfolio.co/build-a-thon-2026',
        source: 'Devfolio'
      },
      {
        title: 'Summer Engineering Fellowship',
        company: 'Web3 Foundation',
        deadline: '2026-05-30T18:30:00Z',
        url: 'https://devfolio.co/web3-fellowship',
        source: 'Devfolio'
      }
    ];
  } else if (sourceName === 'Unstop') {
    return [
      {
        title: 'National Coding Challenge',
        company: 'Tech Giant',
        deadline: '2026-07-01T12:00:00Z',
        url: 'https://unstop.com/competition/national-coding-challenge',
        source: 'Unstop'
      }
    ];
  }
  return [];
}

// Generate content hash (SHA-256 of title + company + deadline)
function generateContentHash(title, company, deadline) {
  const data = `${title.trim().toLowerCase()}|${company.trim().toLowerCase()}|${deadline}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function run() {
  const sources = ['Devfolio', 'Unstop'];
  const allOpportunities = [];

  for (const source of sources) {
    const items = await scrapeSource(source);
    allOpportunities.push(...items);
  }

  console.log(`\n📊 Found ${allOpportunities.length} total opportunities.`);

  const opportunitiesToInsert = allOpportunities.map(item => {
    const hash = generateContentHash(item.title, item.company, item.deadline);
    return {
      title: item.title,
      company: item.company,
      deadline: item.deadline,
      url: item.url,
      source: item.source,
      content_hash: hash
    };
  });

  try {
    const { data, error } = await supabase
      .from('opportunities')
      .upsert(opportunitiesToInsert, { onConflict: 'content_hash' });

    if (error) throw error;
    console.log('✅ Opportunities successfully synced to Supabase.');
  } catch (err) {
    console.error('❌ Failed to sync opportunities to Supabase:', err.message);
    console.log('👉 (Did you set valid SUPABASE_URL and SUPABASE_KEY in .env?)');
  }
}

run().catch(console.error);
