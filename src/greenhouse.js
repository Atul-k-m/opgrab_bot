import crypto from 'crypto';
import axios from 'axios';
import { supabase } from './supabase.js';

// Greenhouse requires a company token (board_token) to fetch jobs.
// Here are a few example companies that use Greenhouse.
const COMPANY_TOKENS = ['vercel', 'figma', 'automattic']; 

async function scrapeGreenhouse(boardToken) {
  console.log(`\n🔍 Fetching jobs for '${boardToken}' from Greenhouse API...`);
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`;
    const { data } = await axios.get(url);
    
    if (!data || !data.jobs) {
      console.log(`ℹ️ No jobs found or invalid response for ${boardToken}`);
      return [];
    }
    
    console.log(`   Found ${data.jobs.length} jobs for ${boardToken}`);
    
    return data.jobs.map(job => ({
      title: job.title,
      company: boardToken.toUpperCase(),
      deadline: null, // Greenhouse API usually doesn't provide deadlines
      url: job.absolute_url,
      source: 'Greenhouse'
    }));
  } catch (err) {
    console.error(`❌ Failed to fetch for ${boardToken}:`, err.message);
    return [];
  }
}

// Generate content hash (SHA-256 of title + company + deadline)
function generateContentHash(title, company, deadline) {
  const data = `${title.trim().toLowerCase()}|${company.trim().toLowerCase()}|${deadline}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function run() {
  const allOpportunities = [];

  for (const token of COMPANY_TOKENS) {
    const jobs = await scrapeGreenhouse(token);
    allOpportunities.push(...jobs);
  }

  console.log(`\n📊 Found ${allOpportunities.length} total Greenhouse opportunities.`);

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

  // Deduplicate by content_hash
  const uniqueInsertions = [];
  const seenHashes = new Set();
  for (const item of opportunitiesToInsert) {
    if (!seenHashes.has(item.content_hash)) {
      seenHashes.add(item.content_hash);
      uniqueInsertions.push(item);
    }
  }

  if (uniqueInsertions.length === 0) {
    console.log('ℹ️ No new opportunities to insert.');
    return;
  }

  try {
    const { data, error } = await supabase
      .from('opportunities')
      .upsert(uniqueInsertions, { onConflict: 'content_hash' });

    if (error) throw error;
    console.log(`✅ Successfully synced ${uniqueInsertions.length} unique Greenhouse jobs to Supabase.`);
  } catch (err) {
    console.error('❌ Failed to sync opportunities to Supabase:', err.message);
  }
}

run().catch(console.error);
