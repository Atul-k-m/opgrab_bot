/**
 * matcher.js — AI Matching Engine (Groq)
 *
 * Uses Groq (llama-3.3-70b-versatile) to intelligently score each opportunity
 * against the user's profile. Falls back to local TF-IDF if Groq
 * is unavailable or quota is exhausted.
 *
 * Groq is called in BATCH mode — one API call to score ~20 opps at once.
 * Free tier: 14,400 requests/day, 6,000 tokens/minute — plenty for this use case.
 */
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // ← NOT 'versatilee' (typo seen in rate-limit logs)

// 5 seconds between batches keeps token usage under the 12k TPM free-tier limit.
// Each batch of 20 opps uses ~3,500 tokens; 5s gap resets the window enough.
// Lower to 3000 if you upgrade to Dev tier.
const BATCH_DELAY_MS = 5000;

const sleep = ms => new Promise(res => setTimeout(res, ms));

// ─── Role exclusion (shared, also used by scraper) ───────────────────────────
const EXCLUDE_KEYWORDS = [
  'phd', 'research scientist', 'postdoc', 'staff engineer',
  'principal', 'director', 'vp ', 'vice president', 'head of',
  'senior manager', 'distinguished', 'chief ',
];

export function isExcluded(title = '') {
  const t = title.toLowerCase();
  return EXCLUDE_KEYWORDS.some(kw => t.includes(kw));
}

// ─── India/Remote preference ──────────────────────────────────────────────────
const INDIA_SIGNALS = ['india', 'remote', 'anywhere', 'work from home', 'wfh', 'online'];

function locationScore(opp) {
  const loc = (opp.location || '').toLowerCase();
  const isIndiaFriendly = INDIA_SIGNALS.some(s => loc.includes(s));
  const indiaSource = ['Internshala', 'Unstop', 'Devfolio'].includes(opp.source);
  if (isIndiaFriendly || indiaSource) return 2.0;
  if (
    loc.includes('united states') || loc.includes('san francisco') ||
    loc.includes('new york') || loc.includes('seattle') || loc.includes('us only')
  ) {
    return -1.0;
  }
  return 0;
}


// ═══════════════════════════════════════════════════════════════════════════════
// GROQ BATCH SCORER
// ═══════════════════════════════════════════════════════════════════════════════
async function scoreWithGroq(opportunities, userProfile) {
  if (!GROQ_KEY) {
    console.warn('⚠️  No GROQ_API_KEY set — falling back to local scoring');
    return null;
  }

  const { skills = [], batch_year, cgpa } = userProfile;

  const oppList = opportunities.map((opp, i) => ({
    idx: i,
    title: opp.title,
    company: opp.company,
    source: opp.source,
    location: opp.location || '',
    tags: (opp.tags || []).slice(0, 5).join(', '),
  }));

  const prompt = `You are an intelligent career opportunity matcher for Indian students.

User Profile:
- Skills: ${skills.join(', ') || 'Not specified'}
- Graduation Batch: ${batch_year || 'Not specified'}
- CGPA: ${cgpa || 'Not specified'}

Opportunities to score (JSON array):
${JSON.stringify(oppList, null, 2)}

For each opportunity, respond with a JSON object with a single key "results" containing an array (same order as input):
{
  "results": [
    {
      "idx": 0,
      "score": 0-100,
      "reason": "1-line reason why this matches or doesn't",
      "relevant": true/false
    }
  ]
}

Scoring rules:
- Score 70-100: Strong match for skills AND location accessible from India (remote/online) AND student-friendly level
- Score 40-69: Partial match — some skills match or relevant domain
- Score 10-39: Weak match, different domain but possibly interesting
- Score 0-9: Not relevant at all
- Penalize heavily: US-only roles with no remote option, PhD/senior positions, irrelevant industries
- Boost: remote/online roles, India-based companies, startups, internships, entry-level
- If batch year suggests 2025/2026/2027 grad, focus on intern/entry-level, not senior

Return ONLY the JSON object described above, nothing else.`;

  try {
    const { data } = await axios.post(
      GROQ_URL,
      {
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      },
      {
        timeout: 30000,
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    const parsed = JSON.parse(text);
    const scores = Array.isArray(parsed) ? parsed : parsed.results;
    if (!Array.isArray(scores)) {
      console.warn('⚠️  Groq returned unexpected shape:', JSON.stringify(parsed).slice(0, 200));
      return null;
    }

    return scores;
  } catch (err) {
    const status = err?.response?.status;
    const detail = err?.response?.data?.error?.message || err.message;
    if (status === 429) {
      console.warn(`⚠️  Groq rate limit hit — switching to local fallback. (${detail})`);
    } else {
      console.warn(`⚠️  Groq scoring failed [${status || 'timeout'}]: ${detail} — using local fallback`);
    }
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL FALLBACK SCORER (TF-IDF style)
// ═══════════════════════════════════════════════════════════════════════════════
const SKILL_TAXONOMY = {
  'python': ['python', 'django', 'flask', 'fastapi', 'pytorch', 'tensorflow', 'pandas', 'numpy', 'ml', 'ai', 'data science', 'machine learning', 'deep learning'],
  'javascript': ['javascript', 'js', 'node', 'react', 'vue', 'angular', 'express', 'next', 'typescript', 'ts', 'frontend', 'backend', 'full stack', 'web dev', 'mern'],
  'java': ['java', 'spring', 'android', 'kotlin', 'backend'],
  'c++': ['c++', 'cpp', 'systems', 'embedded', 'dsa'],
  'rust': ['rust', 'systems programming', 'wasm'],
  'go': ['golang', 'go', 'devops', 'kubernetes', 'cloud'],
  'web development': ['web', 'frontend', 'backend', 'full stack', 'html', 'css', 'react', 'vue', 'angular'],
  'mobile': ['mobile', 'android', 'ios', 'flutter', 'react native', 'swift', 'kotlin'],
  'data science': ['data science', 'analytics', 'statistics', 'tableau', 'power bi', 'sql', 'data engineer'],
  'machine learning': ['machine learning', 'ml', 'ai', 'deep learning', 'nlp', 'computer vision'],
  'devops': ['devops', 'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'cloud', 'terraform'],
  'cybersecurity': ['security', 'cybersecurity', 'penetration testing', 'ethical hacking', 'infosec'],
  'design': ['design', 'ui', 'ux', 'figma', 'graphic design', 'product design'],
  'marketing': ['marketing', 'digital marketing', 'seo', 'content marketing', 'growth'],
  'finance': ['finance', 'fintech', 'accounting', 'banking'],
  'hr': ['hr', 'human resources', 'recruitment', 'talent acquisition'],
  'content': ['content writing', 'copywriting', 'technical writing'],
  'sales': ['sales', 'business development', 'b2b', 'lead generation'],
};

export function expandSkills(skills) {
  const expanded = new Map();
  for (const rawSkill of skills) {
    const skill = rawSkill.toLowerCase().trim();
    expanded.set(skill, (expanded.get(skill) || 0) + 3.0);
    for (const [category, keywords] of Object.entries(SKILL_TAXONOMY)) {
      if (keywords.includes(skill) || category === skill) {
        for (const kw of keywords) {
          expanded.set(kw, Math.max(expanded.get(kw) || 0, kw === skill ? 3.0 : 0.8));
        }
      }
    }
  }
  return expanded;
}

function localScoreOpportunity(opp, expandedSkills) {
  const text = `${opp.title} ${opp.company} ${(opp.tags || []).join(' ')}`.toLowerCase();
  let score = 0;
  const matched = [];

  for (const [kw, weight] of expandedSkills) {
    if (text.includes(kw)) {
      score += weight;
      if (weight >= 1.5) matched.push(kw);
    }
  }

  if (opp.deadline) {
    const days = (new Date(opp.deadline) - new Date()) / 86400000;
    if (days > 0 && days <= 7) score += 3;
    else if (days > 0 && days <= 30) score += 1;
  }

  const internKw = ['intern', 'internship', 'new grad', 'entry level', 'junior', 'fresher', 'trainee'];
  if (internKw.some(kw => text.includes(kw))) score += 2;

  score += locationScore(opp);

  const maxScore = Math.max(...expandedSkills.values()) * 3 + 8;
  const relevancePct = Math.min(Math.round((score / maxScore) * 100), 99);

  return {
    score,
    relevancePct,
    matchedKeywords: [...new Set(matched)].slice(0, 4),
    reason: matched.length ? `Matches: ${matched.slice(0, 3).join(', ')}` : 'Low relevance',
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: rankOpportunities — AI-powered with local fallback
// ═══════════════════════════════════════════════════════════════════════════════
export async function rankOpportunities(opportunities, userSkills, profile = {}, opts = {}) {
  const { limit = 20, minScore = 0, source = null, locationFilter = 'india' } = opts;

  let filtered = opportunities.filter(o => !isExcluded(o.title));

  if (source && source !== 'all') {
    filtered = filtered.filter(o => o.source === source);
  }

  if (locationFilter === 'india') {
    filtered = filtered.filter(o => {
      const loc = (o.location || '').toLowerCase();
      const isIndia = INDIA_SIGNALS.some(s => loc.includes(s));
      const indiaSource = ['Internshala', 'Unstop', 'Devfolio'].includes(o.source);
      const remoteSource = ['Remotive', 'Arbeitnow', 'TheMuse', 'Devpost'].includes(o.source);
      return isIndia || indiaSource || remoteSource || loc === '';
    });
  }

  if (!filtered.length) return [];

  const userProfile = { skills: userSkills, ...profile };
  const BATCH_SIZE = 20;
  const scored = [];

  if (GROQ_KEY) {
    for (let i = 0; i < Math.min(filtered.length, 100); i += BATCH_SIZE) {
      // Wait between batches to stay under the 12k TPM free-tier limit
      if (i > 0) {
        console.log(`⏳ Waiting ${BATCH_DELAY_MS / 1000}s before next Groq batch...`);
        await sleep(BATCH_DELAY_MS);
      }

      const batch = filtered.slice(i, i + BATCH_SIZE);
      const groqScores = await scoreWithGroq(batch, userProfile);

      if (groqScores) {
        for (const gs of groqScores) {
          const opp = batch[gs.idx];
          if (!opp) continue;
          const locBonus = locationScore(opp);
          const finalScore = gs.score + (locBonus * 5);
          scored.push({
            ...opp,
            score: finalScore,
            relevancePct: Math.min(gs.score, 99),
            matchedKeywords: [],
            reason: gs.reason || '',
            scoredByAI: true,
          });
        }
      } else {
        // Groq failed for this batch — use local scorer
        const expanded = expandSkills(userSkills);
        for (const opp of batch) {
          const { score, relevancePct, matchedKeywords, reason } = localScoreOpportunity(opp, expanded);
          scored.push({ ...opp, score, relevancePct, matchedKeywords, reason, scoredByAI: false });
        }
      }
    }

    // Anything beyond 100 gets local scoring (avoids burning rate limit)
    if (filtered.length > 100) {
      const expanded = expandSkills(userSkills);
      for (const opp of filtered.slice(100)) {
        const { score, relevancePct, matchedKeywords, reason } = localScoreOpportunity(opp, expanded);
        scored.push({ ...opp, score, relevancePct, matchedKeywords, reason, scoredByAI: false });
      }
    }
  } else {
    // No Groq key — full local scoring
    const expanded = expandSkills(userSkills);
    for (const opp of filtered) {
      const { score, relevancePct, matchedKeywords, reason } = localScoreOpportunity(opp, expanded);
      scored.push({ ...opp, score, relevancePct, matchedKeywords, reason, scoredByAI: false });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(o => o.score >= minScore).slice(0, limit);
}


// ═══════════════════════════════════════════════════════════════════════════════
// DIGEST GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════
export async function generateDigest(opportunities, profile) {
  const skills = profile.skills || [];
  const topMatches = await rankOpportunities(opportunities, skills, profile, { limit: 5, minScore: 10 });

  const now = new Date();
  const expiringSoon = opportunities
    .filter(o => o.deadline && !isExcluded(o.title))
    .map(o => ({ ...o, daysLeft: (new Date(o.deadline) - now) / 86400000 }))
    .filter(o => o.daysLeft > 0 && o.daysLeft <= 7)
    .slice(0, 3);

  const yesterday = new Date(now - 86400000);
  const newOpps = opportunities
    .filter(o => o.created_at && new Date(o.created_at) > yesterday && !isExcluded(o.title))
    .slice(0, 5);

  const sourceBreakdown = {};
  opportunities.forEach(o => {
    sourceBreakdown[o.source] = (sourceBreakdown[o.source] || 0) + 1;
  });

  return {
    topMatches,
    expiringSoon,
    newOpps,
    sourceBreakdown,
    totalOpps: opportunities.length,
    profileStrength: skills.length >= 3 ? 'strong' : skills.length >= 1 ? 'moderate' : 'weak',
    aiPowered: !!GROQ_KEY,
  };
}