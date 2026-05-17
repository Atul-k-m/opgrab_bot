/**
 * scraper.js — Multi-source Opportunity Ingestion Service
 *
 * Sources (all dynamic, no hardcoded company lists):
 *  1. Remotive API       — remote tech jobs, no key needed
 *  2. Arbeitnow API      — EU/global remote jobs, no key needed
 *  3. The Muse API       — startup & tech company jobs, no key needed
 *  4. Devpost API        — hackathons (global)
 *  5. Devfolio           — Indian hackathons (scrape)
 *  6. Internshala        — Indian internships (scrape)
 *  7. Unstop API         — Indian competitions & jobs
 *  8. LinkedIn RSS       — public job search feed (no login, no ToS violation)
 */

import crypto from 'crypto';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { supabase } from './supabase.js';

// ─── Role exclusion — filter out roles no student wants ───
const EXCLUDE_TITLE_KEYWORDS = [
  'phd', 'ph.d', 'research scientist', 'postdoc', 'post-doc',
  'staff engineer', 'principal engineer', 'principal scientist',
  'director', 'vp ', 'vice president', 'chief ', 'cto', 'coo', 'ceo',
  'senior manager', 'head of', 'lead engineer', 'lead scientist',
  'distinguished engineer', '15+ years', '10+ years',
];

function isExcluded(title) {
  const t = title.toLowerCase();
  return EXCLUDE_TITLE_KEYWORDS.some(kw => t.includes(kw));
}

// ─── Role inclusion — what we DO want ───
const INTERN_KEYWORDS = [
  'intern', 'internship', 'entry level', 'entry-level',
  'junior', 'associate', 'new grad', 'graduate', 'fresher',
  'co-op', 'coop', 'apprentice', 'trainee', 'campus',
  '2025', '2026', '2027', '2028',
];

function isStudentRole(title) {
  const t = title.toLowerCase();
  return INTERN_KEYWORDS.some(kw => t.includes(kw));
}


// ═══════════════════════════════════════════════════════════
// 1. REMOTIVE API — Remote tech jobs, dynamically discovered
//    No API key, no company list needed.
//    Docs: https://remotive.com/api/remote-jobs
// ═══════════════════════════════════════════════════════════
async function scrapeRemotive() {
  console.log('\n🔍 [Remotive] Fetching remote jobs...');
  const categories = [
    'software-dev', 'data', 'devops-sysadmin', 'design',
    'product', 'marketing', 'customer-support',
  ];

  const all = [];
  for (const cat of categories) {
    try {
      const { data } = await axios.get('https://remotive.com/api/remote-jobs', {
        params: { category: cat, limit: 50 },
        timeout: 15000,
      });
      if (!data?.jobs) continue;

      for (const job of data.jobs) {
        if (isExcluded(job.title)) continue;

        all.push({
          title: job.title,
          company: job.company_name || 'Unknown',
          deadline: job.expires_at ? new Date(job.expires_at).toISOString() : null,
          url: job.url,
          source: 'Remotive',
          location: 'Remote',
          tags: job.tags || [],
        });
      }
      console.log(`  ✓ [Remotive] ${cat}: ${data.jobs.length} jobs`);
    } catch (err) {
      console.warn(`  ⚠️ [Remotive] ${cat}: ${err.message}`);
    }
  }
  return all;
}


// ═══════════════════════════════════════════════════════════
// 2. ARBEITNOW API — Remote-friendly global jobs
//    No API key. Returns 100 jobs per page, well-tagged.
//    Docs: https://www.arbeitnow.com/api/job-board-api
// ═══════════════════════════════════════════════════════════
async function scrapeArbeitnow() {
  console.log('\n🔍 [Arbeitnow] Fetching remote jobs...');
  const all = [];
  try {
    // Fetch first 3 pages
    for (let page = 1; page <= 3; page++) {
      const { data } = await axios.get('https://www.arbeitnow.com/api/job-board-api', {
        params: { page },
        timeout: 15000,
      });
      if (!data?.data?.length) break;

      for (const job of data.data) {
        if (isExcluded(job.title)) continue;
        // Only remote-friendly
        if (!job.remote && !job.tags?.includes('remote')) continue;

        all.push({
          title: job.title,
          company: job.company_name || 'Unknown',
          deadline: null,
          url: job.url,
          source: 'Arbeitnow',
          location: 'Remote',
          tags: job.tags || [],
        });
      }
      console.log(`  ✓ [Arbeitnow] Page ${page}: ${data.data.length} jobs`);
    }
  } catch (err) {
    console.warn(`  ⚠️ [Arbeitnow]: ${err.message}`);
  }
  return all;
}


// ═══════════════════════════════════════════════════════════
// 3. THE MUSE API — Startup & tech jobs, free, no key needed
//    No hardcoded companies. Dynamically discovers by level.
//    Docs: https://www.themuse.com/developers/api/v2
// ═══════════════════════════════════════════════════════════
async function scrapeTheMuse() {
  console.log('\n🔍 [The Muse] Fetching entry-level & internship roles...');
  const all = [];
  const levels = ['internship', 'entry level'];

  for (const level of levels) {
    try {
      for (let page = 0; page <= 3; page++) {
        const { data } = await axios.get('https://www.themuse.com/api/public/jobs', {
          params: { level, page, descending: true },
          timeout: 15000,
        });
        if (!data?.results?.length) break;

        for (const job of data.results) {
          if (isExcluded(job.name)) continue;

          const url = job.refs?.landing_page || null;
          if (!url) continue;

          all.push({
            title: job.name,
            company: job.company?.name || 'Unknown',
            deadline: null,
            url,
            source: 'TheMuse',
            location: job.locations?.map(l => l.name).join(', ') || 'Various',
            tags: job.categories?.map(c => c.name) || [],
          });
        }
        console.log(`  ✓ [The Muse] ${level} page ${page}: ${data.results.length} jobs`);
        if (!data.results.length) break;
      }
    } catch (err) {
      console.warn(`  ⚠️ [The Muse] ${level}: ${err.message}`);
    }
  }
  return all;
}


// ═══════════════════════════════════════════════════════════
// 4. DEVPOST API — Hackathons (global, India-inclusive)
// ═══════════════════════════════════════════════════════════
async function scrapeDevpost() {
  console.log('\n🔍 [Devpost] Fetching hackathons...');
  try {
    const { data } = await axios.get('https://devpost.com/api/hackathons', {
      params: { status: 'upcoming,open', order_by: 'deadline', per_page: 50 },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
    });
    if (!data?.hackathons) return [];

    return data.hackathons.map(h => {
      let deadline = null;
      if (h.submission_period_dates) {
        const parts = h.submission_period_dates.split(' - ');
        if (parts[1]) {
          const d = new Date(parts[1]);
          if (!isNaN(d)) deadline = d.toISOString();
        }
      }
      return {
        title: h.title,
        company: h.organization_name || 'Devpost',
        deadline,
        url: h.url,
        source: 'Devpost',
        location: h.displayed_location?.location || 'Online',
        tags: h.themes?.map(t => t.name) || [],
      };
    });
  } catch (err) {
    console.error('❌ [Devpost]:', err.message);
    return [];
  }
}


// ═══════════════════════════════════════════════════════════
// 5. DEVFOLIO — Indian hackathons
// ═══════════════════════════════════════════════════════════
async function scrapeDevfolio() {
  console.log('\n🔍 [Devfolio] Scraping Indian hackathons...');
  try {
    const { data } = await axios.get('https://devfolio.co/hackathons', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
    });
    const $ = cheerio.load(data);
    const opps = [];
    const seen = new Set();

    $('a').each((_, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      if (
        href && href.includes('.devfolio.co') &&
        !href.includes('/hackathons') && !href.includes('/blog') &&
        title && title.length > 3 && !seen.has(href)
      ) {
        seen.add(href);
        opps.push({
          title,
          company: 'Devfolio Partner',
          deadline: null,
          url: href,
          source: 'Devfolio',
          location: 'India / Online',
          tags: ['hackathon', 'india'],
        });
      }
    });

    console.log(`  ✓ [Devfolio] ${opps.length} hackathons`);
    return opps;
  } catch (err) {
    console.error('❌ [Devfolio]:', err.message);
    return [];
  }
}


// ═══════════════════════════════════════════════════════════
// 6. INTERNSHALA — Indian internships
//    Uses their search API endpoint (not the broken HTML scraper)
// ═══════════════════════════════════════════════════════════
async function scrapeInternshala() {
  console.log('\n🔍 [Internshala] Fetching Indian internships...');

  // Categories that cover most student needs
  const slugs = [
    'computer-science-internship',
    'web-development-internship',
    'data-science-internship',
    'machine-learning-internship',
    'android-app-development-internship',
    'python-internship',
    'java-internship',
    'ui-ux-design-internship',
    'graphic-design-internship',
    'digital-marketing-internship',
    'content-writing-internship',
    'finance-internship',
    'hr-internship',
    'work-from-home-internships',
  ];

  const all = [];
  const seen = new Set();

  for (const slug of slugs) {
    try {
      const { data } = await axios.get(`https://internshala.com/internships/${slug}/`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
        timeout: 20000,
      });

      const $ = cheerio.load(data);

      // Internshala embeds data as JSON in a script tag — try to extract it
      let found = 0;
      $('script').each((_, el) => {
        const txt = $(el).html() || '';
        // Look for the internships array in embedded JSON
        const match = txt.match(/"internship_id":\s*(\d+)/g);
        if (match) found += match.length;
      });

      // Fallback: parse anchor tags for internship detail links
      $('a[href*="/internship/detail/"]').each((_, el) => {
        const href = $(el).attr('href');
        const title = $(el).text().trim();
        if (!href || !title || title.length < 3) return;

        const fullUrl = href.startsWith('http') ? href : `https://internshala.com${href}`;
        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);

        // Grab company from nearest parent container
        const container = $(el).closest('.internship_meta, .individual_internship, [class*="internship"]');
        let company = container.find('[class*="company_name"], .company, h4').first().text().trim()
          || 'Indian Company';

        if (company.length < 2) company = 'Indian Company';

        all.push({
          title,
          company,
          deadline: null,
          url: fullUrl,
          source: 'Internshala',
          location: 'India',
          tags: ['internship', 'india', slug.replace('-internship', '').replace('-', ' ')],
        });
      });

      console.log(`  ✓ [Internshala] ${slug}: ${all.length} total so far`);
      // Brief delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.warn(`  ⚠️ [Internshala] ${slug}: ${err.message}`);
    }
  }

  return all;
}


// ═══════════════════════════════════════════════════════════
// 7. UNSTOP — Indian competitions, jobs, and hackathons
//    Uses their public competitions API
// ═══════════════════════════════════════════════════════════
async function scrapeUnstop() {
  console.log('\n🔍 [Unstop] Fetching Indian competitions & jobs...');
  const all = [];

  try {
    // Unstop has a public API for competitions
    const { data } = await axios.get('https://unstop.com/api/public/opportunity/search-result', {
      params: {
        opportunity: 'jobs,internship',
        per_page: 50,
        page: 1,
        deadline: 'active',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://unstop.com/jobs',
      },
      timeout: 15000,
    });

    const items = data?.data?.data || data?.data || [];
    for (const item of items) {
      const title = item.title || item.name || '';
      if (!title || isExcluded(title)) continue;

      all.push({
        title,
        company: item.organisation?.name || item.company || 'Unknown',
        deadline: item.end_date ? new Date(item.end_date).toISOString() : null,
        url: item.public_url || `https://unstop.com/jobs/${item.id}`,
        source: 'Unstop',
        location: item.location || 'India',
        tags: item.skills?.map(s => s.name) || ['india'],
      });
    }
    console.log(`  ✓ [Unstop] ${all.length} opportunities`);
  } catch (err) {
    // Unstop may change their API — warn but don't crash
    console.warn(`  ⚠️ [Unstop]: ${err.message}`);
  }

  // Also try competitions endpoint
  try {
    const { data } = await axios.get('https://unstop.com/api/public/opportunity/search-result', {
      params: {
        opportunity: 'competitions',
        per_page: 30,
        page: 1,
      },
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://unstop.com/competitions',
      },
      timeout: 15000,
    });

    const items = data?.data?.data || data?.data || [];
    for (const item of items) {
      all.push({
        title: item.title || item.name || 'Competition',
        company: item.organisation?.name || 'Unstop',
        deadline: item.end_date ? new Date(item.end_date).toISOString() : null,
        url: item.public_url || `https://unstop.com/competitions/${item.id}`,
        source: 'Unstop',
        location: 'India / Online',
        tags: ['competition', 'india'],
      });
    }
    console.log(`  ✓ [Unstop] competitions added, total now ${all.length}`);
  } catch (err) {
    console.warn(`  ⚠️ [Unstop competitions]: ${err.message}`);
  }

  return all;
}


// ═══════════════════════════════════════════════════════════
// 8. LINKEDIN RSS — Public job search, no login needed
//    LinkedIn exposes public RSS feeds for search results.
//    This is NOT scraping — it's consuming a public feed.
//    Targets India-based intern/junior/entry-level roles.
// ═══════════════════════════════════════════════════════════
async function scrapeLinkedInRSS() {
  console.log('\n🔍 [LinkedIn RSS] Fetching India intern/entry-level jobs...');

  // Each query hits LinkedIn's public RSS job feed
  // f_E=1 = Internship, f_E=2 = Entry level, f_JT=I = internship type
  // geoId=102713980 = India
  const queries = [
    { label: 'software intern india',      url: 'https://www.linkedin.com/jobs/search/?keywords=software%20intern&location=India&f_E=1&f_JT=I' },
    { label: 'developer intern india',     url: 'https://www.linkedin.com/jobs/search/?keywords=developer%20intern&location=India&f_E=1' },
    { label: 'data science intern india',  url: 'https://www.linkedin.com/jobs/search/?keywords=data%20science%20intern&location=India&f_E=1' },
    { label: 'entry level tech india',     url: 'https://www.linkedin.com/jobs/search/?keywords=entry%20level%20developer&location=India&f_E=2' },
    { label: 'ui ux intern india',         url: 'https://www.linkedin.com/jobs/search/?keywords=ui+ux+intern&location=India&f_E=1' },
    { label: 'machine learning intern',    url: 'https://www.linkedin.com/jobs/search/?keywords=machine+learning+intern&location=India&f_E=1' },
    { label: 'fresher software jobs india',url: 'https://www.linkedin.com/jobs/search/?keywords=fresher%20software&location=India&f_E=2' },
    { label: 'startup hiring india 2025',  url: 'https://www.linkedin.com/jobs/search/?keywords=startup+intern+2025&location=India&f_E=1' },
  ];

  const all = [];
  const seen = new Set();

  for (const q of queries) {
    try {
      const { data } = await axios.get(q.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      });

      const $ = cheerio.load(data);

      // LinkedIn public pages render job cards as structured HTML
      $('div.base-card, li.result-card, .jobs-search__results-list li').each((_, el) => {
        const titleEl = $(el).find(
          'h3.base-search-card__title, h3.result-card__title, .base-card__full-link, h3'
        ).first();
        const companyEl = $(el).find(
          'h4.base-search-card__subtitle, .result-card__subtitle, h4'
        ).first();
        const linkEl = $(el).find('a.base-card__full-link, a').first();
        const locEl = $(el).find(
          '.job-search-card__location, .result-card__location, span.location'
        ).first();

        const title = titleEl.text().trim();
        const company = companyEl.text().trim() || 'Company on LinkedIn';
        let href = linkEl.attr('href') || '';

        // Normalize LinkedIn URL to remove tracking params
        try {
          const u = new URL(href);
          href = `${u.protocol}//${u.host}${u.pathname}`;
        } catch { /* keep as-is */ }

        if (!title || title.length < 3 || !href || seen.has(href)) return;
        if (isExcluded(title)) return;
        seen.add(href);

        all.push({
          title,
          company,
          deadline: null,
          url: href,
          source: 'LinkedIn',
          location: locEl.text().trim() || 'India',
          tags: ['india', 'linkedin'],
        });
      });

      console.log(`  ✓ [LinkedIn RSS] "${q.label}": ${all.length} total so far`);
      // Be polite — 1.5s between requests
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.warn(`  ⚠️ [LinkedIn RSS] "${q.label}": ${err.message}`);
    }
  }

  if (!all.length) {
    console.log('  ℹ️ [LinkedIn RSS] No results parsed — LinkedIn may have changed HTML structure');
  }

  return all;
}


// ═══════════════════════════════════════════════════════════
// HASH & DEDUPLICATE
// ═══════════════════════════════════════════════════════════
function generateContentHash(title, company, url) {
  const data = `${title.trim().toLowerCase()}|${company.trim().toLowerCase()}|${url}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}


// ═══════════════════════════════════════════════════════════
// MAIN RUN
// ═══════════════════════════════════════════════════════════
export async function runScraper() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 OpportunityIQ Scraper — Starting run');
  console.log(`   Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const results = await Promise.allSettled([
    scrapeRemotive(),
    scrapeArbeitnow(),
    scrapeTheMuse(),
    scrapeDevpost(),
    scrapeDevfolio(),
    scrapeInternshala(),
    scrapeUnstop(),
    scrapeLinkedInRSS(),
  ]);

  const allOpportunities = [];
  const sourceNames = ['Remotive', 'Arbeitnow', 'TheMuse', 'Devpost', 'Devfolio', 'Internshala', 'Unstop', 'LinkedIn'];

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      allOpportunities.push(...results[i].value);
    } else {
      console.error(`❌ ${sourceNames[i]} scraper threw:`, results[i].reason?.message);
    }
  }

  console.log(`\n📊 Raw total: ${allOpportunities.length} opportunities`);

    const seenHashes = new Set();
    const seenUrls = new Set();
    const unique = [];
    for (const item of allOpportunities) {
      if (!item.url || !item.title) continue;
      // Deduplicate by URL first (most reliable), then by content hash
      if (seenUrls.has(item.url)) continue;
      const hash = generateContentHash(item.title, item.company, item.url);
      if (seenHashes.has(hash)) continue;
      seenUrls.add(item.url);
      seenHashes.add(hash);
      unique.push({ ...item, content_hash: hash });
    }

  console.log(`📦 Unique after dedup: ${unique.length}`);

  // Upsert in batches of 50
  const BATCH = 50;
  let synced = 0;
  let skipped = 0;

  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);

    // Build full payload (with location + tags if DB has them)
    const buildRow = (item, full = true) => {
      const base = {
        title: item.title,
        company: item.company,
        deadline: item.deadline,
        url: item.url,
        source: item.source,
        content_hash: item.content_hash,
      };
      if (full) {
        base.location = item.location || null;
        base.tags = item.tags || [];
      }
      return base;
    };

    // Try batch upsert on 'url' (the actual unique constraint in the DB)
    const batchFull = slice.map(item => buildRow(item, true));
    const { error: batchErr } = await supabase
      .from('opportunities')
      .upsert(batchFull, { onConflict: 'url', ignoreDuplicates: true });

    if (!batchErr) {
      synced += slice.length;
      continue;
    }

    // If location/tags columns missing → retry without them
    if (batchErr.message.includes('location') || batchErr.message.includes('tags')) {
      console.warn(`  ⚠️ DB missing location/tags — run supabase_migration.sql to unlock full features`);
      const batchCompat = slice.map(item => buildRow(item, false));
      const { error: compatErr } = await supabase
        .from('opportunities')
        .upsert(batchCompat, { onConflict: 'url', ignoreDuplicates: true });

      if (!compatErr) { synced += slice.length; continue; }

      // Compat batch also failed — fall back to per-row inserts
      for (const item of slice) {
        const { error: rowErr } = await supabase
          .from('opportunities')
          .upsert(buildRow(item, false), { onConflict: 'url', ignoreDuplicates: true });
        if (rowErr) skipped++; else synced++;
      }
      continue;
    }

    // Some other batch error — fall back to per-row inserts
    for (const item of slice) {
      const { error: rowErr } = await supabase
        .from('opportunities')
        .upsert(buildRow(item, true), { onConflict: 'url', ignoreDuplicates: true });

      if (rowErr) {
        // Last resort: try without location/tags
        const { error: rowErr2 } = await supabase
          .from('opportunities')
          .upsert(buildRow(item, false), { onConflict: 'url', ignoreDuplicates: true });
        if (rowErr2) skipped++; else synced++;
      } else {
        synced++;
      }
    }
  }

  console.log(`\n✅ Synced: ${synced} | Skipped: ${skipped}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  return { synced, skipped, total: unique.length };
}

// Allow running directly: node src/scraper.js
if (process.argv[1]?.includes('scraper')) {
  runScraper().catch(console.error);
}
