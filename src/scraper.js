import crypto from 'crypto';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { supabase } from './supabase.js';

// 1. Devfolio Scraper
async function scrapeDevfolio() {
  console.log(`\n🔍 Scraping real data from Devfolio...`);
  try {
    const { data } = await axios.get('https://devfolio.co/hackathons', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(data);
    const opportunities = [];
    
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      
      if (href && href.includes('.devfolio.co') && 
          !href.includes('devfolio.co/hackathons') && 
          !href.includes('devfolio.co/blog') &&
          !href.includes('devfolio.co/home')) {
        
        if (title && title.length > 2) {
          opportunities.push({
            title: title,
            company: 'Devfolio Partner',
            deadline: null,
            url: href,
            source: 'Devfolio'
          });
        }
      }
    });
    
    const uniqueOpps = [];
    const seenUrls = new Set();
    for (const opp of opportunities) {
      if (!seenUrls.has(opp.url)) {
        seenUrls.add(opp.url);
        uniqueOpps.push(opp);
      }
    }
    
    return uniqueOpps;
  } catch (err) {
    console.error('❌ Failed to scrape Devfolio:', err.message);
    return [];
  }
}

// 2. Devpost Scraper
async function scrapeDevpost() {
  console.log(`\n🔍 Fetching real data from Devpost API...`);
  try {
    const { data } = await axios.get('https://devpost.com/api/hackathons', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!data || !data.hackathons) {
      return [];
    }
    
    const opportunities = data.hackathons.map(item => {
      let deadline = null;
      if (item.submission_period_dates) {
        const parts = item.submission_period_dates.split(' - ');
        if (parts.length === 2) {
          const parsedDate = new Date(parts[1]);
          if (!isNaN(parsedDate.getTime())) {
            deadline = parsedDate.toISOString();
          }
        }
      }
      
      return {
        title: item.title,
        company: item.organization_name || 'Unknown',
        deadline: deadline,
        url: item.url,
        source: 'Devpost'
      };
    });
    
    return opportunities;
  } catch (err) {
    console.error('❌ Failed to fetch from Devpost API:', err.message);
    return [];
  }
}

// 3. Internshala Scraper
async function scrapeInternshala() {
  console.log(`\n🔍 Scraping real data from Internshala...`);
  try {
    // Scrape category-specific pages for diverse, role-relevant results
    const pages = [
      'https://internshala.com/internships/computer-science-internship/',
      'https://internshala.com/internships/web-development-internship/',
      'https://internshala.com/internships/data-science-internship/',
      'https://internshala.com/internships/marketing-internship/',
      'https://internshala.com/internships/graphic-design-internship/',
      'https://internshala.com/internships/finance-internship/',
      'https://internshala.com/internships/content-writing-internship/',
      'https://internshala.com/internships/hr-internship/',
      'https://internshala.com/internships/work-from-home-internships/',
    ];

    const opportunities = [];
    const seenUrls = new Set();

    for (const pageUrl of pages) {
      try {
        const { data } = await axios.get(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: 15000
        });
        
        const $ = cheerio.load(data);
        
        // Internshala renders listings as: <h2><a href="/internship/detail/...">Title</a></h2>
        // followed by a duplicate <a> with the same link, then company name text, then location link
        $('a').each((i, el) => {
          const href = $(el).attr('href');
          const title = $(el).text().trim();
          
          if (href && href.includes('/internship/detail/') && title && title.length > 2) {
            const fullUrl = href.startsWith('http') ? href : `https://internshala.com${href}`;
            
            if (seenUrls.has(fullUrl)) return; // skip duplicate anchors per listing
            seenUrls.add(fullUrl);
            
            // The company name is typically the next text sibling after the <a> inside the parent container
            const parent = $(el).parent();
            let company = 'Unknown Company';
            
            // If parent is h2, the company name is the next sibling's text
            if (parent.is('h2')) {
              // After the h2 there's a duplicate <a>, then company text, then location
              const siblings = parent.nextAll();
              for (let j = 0; j < siblings.length; j++) {
                const sibText = $(siblings[j]).text().trim();
                // Skip if it's the duplicate link or a location link
                if (sibText && sibText.length > 1 && 
                    !$(siblings[j]).attr('href')?.includes('/internship/detail/') &&
                    sibText !== title) {
                  company = sibText;
                  break;
                }
              }
            }
            
            opportunities.push({
              title: title,
              company: company,
              deadline: null,
              url: fullUrl,
              source: 'Internshala'
            });
          }
        });
        
        console.log(`  ✓ Page scraped: ${pageUrl} (${opportunities.length} total so far)`);
      } catch (pageErr) {
        console.warn(`  ⚠️ Failed to scrape page: ${pageUrl} — ${pageErr.message}`);
      }
    }
    
    return opportunities;
  } catch (err) {
    console.error('❌ Failed to scrape Internshala:', err.message);
    return [];
  }
}

// 4. Greenhouse Scraper
// Greenhouse exposes public JSON APIs at: https://boards-api.greenhouse.io/v1/boards/{company}/jobs
async function scrapeGreenhouse() {
  console.log(`\n🔍 Scraping jobs from Greenhouse boards...`);
  
  // Well-known companies with public Greenhouse boards
  const companies = [
    { slug: 'airbnb', name: 'Airbnb' },
    { slug: 'discord', name: 'Discord' },
    { slug: 'figma', name: 'Figma' },
    { slug: 'duolingo', name: 'Duolingo' },
    { slug: 'lyft', name: 'Lyft' },
    { slug: 'brex', name: 'Brex' },
    { slug: 'verkada', name: 'Verkada' },
    { slug: 'coinbase', name: 'Coinbase' },
    { slug: 'flexport', name: 'Flexport' },
    { slug: 'plaid', name: 'Plaid' },
    { slug: 'ramp', name: 'Ramp' },
    { slug: 'anduril', name: 'Anduril' },
    { slug: 'databricks', name: 'Databricks' },
    { slug: 'cockroachlabs', name: 'Cockroach Labs' },
    { slug: 'benchling', name: 'Benchling' },
    { slug: 'rippling', name: 'Rippling' },
    { slug: 'scale', name: 'Scale AI' },
    { slug: 'snyk', name: 'Snyk' },
    { slug: 'gusto', name: 'Gusto' },
  ];

  const opportunities = [];

  for (const company of companies) {
    try {
      const { data } = await axios.get(
        `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs`,
        { timeout: 10000 }
      );

      if (!data || !data.jobs) continue;

      // Broadened filter for intern/entry/new-grad roles
      const internKeywords = ['intern', 'internship', 'entry', 'junior', 'associate', 'new grad', 'graduate', 'early career', 'co-op', 'apprentice', '2027', '2026'];
      
      const filtered = data.jobs.filter(job => {
        const titleLower = job.title.toLowerCase();
        return internKeywords.some(kw => titleLower.includes(kw));
      });

      for (const job of filtered) {
        opportunities.push({
          title: job.title,
          company: company.name,
          deadline: job.updated_at ? new Date(job.updated_at).toISOString() : null,
          url: job.absolute_url,
          source: 'Greenhouse'
        });
      }

      if (filtered.length > 0) {
        console.log(`  ✓ ${company.name}: ${filtered.length} intern/entry-level roles`);
      }
    } catch (err) {
      // Silent fail for individual companies — some slugs may be invalid or rate-limited
      console.warn(`  ⚠️ ${company.name}: ${err.message}`);
    }
  }

  return opportunities;
}

// Generate content hash (SHA-256 of title + company + deadline)
function generateContentHash(title, company, deadline) {
  const data = `${title.trim().toLowerCase()}|${company.trim().toLowerCase()}|${deadline}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function run() {
  const allOpportunities = [];

  const devfolioItems = await scrapeDevfolio();
  allOpportunities.push(...devfolioItems);

  const devpostItems = await scrapeDevpost();
  allOpportunities.push(...devpostItems);

  const internshalaItems = await scrapeInternshala();
  allOpportunities.push(...internshalaItems);

  const greenhouseItems = await scrapeGreenhouse();
  allOpportunities.push(...greenhouseItems);

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

  // Deduplicate by both content_hash AND url before sending to Supabase
  const uniqueInsertions = [];
  const seenHashes = new Set();
  const seenUrls = new Set();
  for (const item of opportunitiesToInsert) {
    if (!seenHashes.has(item.content_hash) && !seenUrls.has(item.url)) {
      seenHashes.add(item.content_hash);
      seenUrls.add(item.url);
      uniqueInsertions.push(item);
    } else {
      console.log(`⚠️ Skipping in-memory duplicate: ${item.title}`);
    }
  }

  // Batch insert in chunks of 50 to avoid payload limits
  const BATCH_SIZE = 50;
  let synced = 0;
  let skipped = 0;

  for (let i = 0; i < uniqueInsertions.length; i += BATCH_SIZE) {
    const batch = uniqueInsertions.slice(i, i + BATCH_SIZE);
    try {
      const { data, error } = await supabase
        .from('opportunities')
        .upsert(batch, { 
          onConflict: 'content_hash',
          ignoreDuplicates: true 
        });

      if (error) throw error;
      synced += batch.length;
    } catch (err) {
      // If content_hash upsert fails due to url conflict, try one-by-one
      console.warn(`  ⚠️ Batch insert failed, falling back to individual inserts...`);
      for (const item of batch) {
        try {
          const { error: singleErr } = await supabase
            .from('opportunities')
            .upsert(item, { onConflict: 'content_hash', ignoreDuplicates: true });
          if (!singleErr) synced++;
          else skipped++;
        } catch {
          skipped++;
        }
      }
    }
  }

  console.log(`✅ Synced ${synced} opportunities to Supabase (${skipped} skipped).`);
}

run().catch(console.error);
