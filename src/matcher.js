/**
 * matcher.js — Local AI Matching Engine
 * 
 * TF-IDF inspired relevance scoring + cosine similarity
 * No external API needed — this IS the intelligence layer.
 */

// ─── Skill Taxonomy ───
// Maps broad skill categories to related keywords for fuzzy matching
const SKILL_TAXONOMY = {
  // Programming Languages
  'python': ['python', 'django', 'flask', 'fastapi', 'pytorch', 'tensorflow', 'pandas', 'numpy', 'data science', 'machine learning', 'ml', 'ai', 'deep learning'],
  'javascript': ['javascript', 'js', 'node', 'nodejs', 'react', 'vue', 'angular', 'express', 'next', 'nextjs', 'typescript', 'ts', 'frontend', 'front-end', 'full stack', 'fullstack', 'web development', 'web dev', 'mern', 'mean'],
  'java': ['java', 'spring', 'springboot', 'spring boot', 'android', 'kotlin', 'backend', 'microservices'],
  'c++': ['c++', 'cpp', 'c', 'systems', 'embedded', 'competitive programming', 'dsa', 'data structures'],
  'rust': ['rust', 'systems programming', 'wasm', 'webassembly'],
  'go': ['go', 'golang', 'devops', 'kubernetes', 'cloud'],

  // Domains
  'web development': ['web', 'website', 'frontend', 'front-end', 'backend', 'back-end', 'full stack', 'fullstack', 'html', 'css', 'react', 'vue', 'angular', 'web dev', 'web development'],
  'mobile': ['mobile', 'android', 'ios', 'flutter', 'react native', 'swift', 'kotlin', 'app development'],
  'data science': ['data science', 'data analytics', 'data analysis', 'analytics', 'statistics', 'visualization', 'tableau', 'power bi', 'sql', 'data engineer'],
  'machine learning': ['machine learning', 'ml', 'ai', 'artificial intelligence', 'deep learning', 'nlp', 'computer vision', 'neural network', 'model training'],
  'devops': ['devops', 'ci/cd', 'docker', 'kubernetes', 'k8s', 'aws', 'azure', 'gcp', 'cloud', 'infrastructure', 'terraform'],
  'cybersecurity': ['security', 'cybersecurity', 'cyber security', 'penetration testing', 'ethical hacking', 'infosec', 'soc', 'network security'],
  'design': ['design', 'ui', 'ux', 'ui/ux', 'figma', 'graphic design', 'product design', 'visual design', 'creative'],
  'marketing': ['marketing', 'digital marketing', 'seo', 'sem', 'social media', 'content marketing', 'growth', 'brand'],
  'finance': ['finance', 'accounting', 'fintech', 'banking', 'investment', 'wealth management', 'tally'],
  'hr': ['hr', 'human resources', 'recruitment', 'talent acquisition', 'hiring', 'people operations'],
  'content': ['content writing', 'content', 'copywriting', 'blogging', 'technical writing', 'documentation'],
  'sales': ['sales', 'business development', 'b2b', 'b2c', 'inside sales', 'field sales', 'lead generation'],
};

// ─── IDF-like weights (rarer skills = more valuable match) ───
const RARITY_BOOST = {
  'rust': 2.5, 'go': 2.0, 'devops': 1.8, 'cybersecurity': 2.0,
  'machine learning': 1.8, 'data science': 1.5, 'mobile': 1.3,
  'c++': 1.5, 'python': 1.0, 'javascript': 1.0,
  'design': 1.2, 'marketing': 0.8, 'sales': 0.7, 'hr': 0.7,
  'content': 0.8, 'finance': 1.1, 'web development': 0.9,
};

/**
 * Expand user skills into a weighted keyword set using the taxonomy
 * @param {string[]} skills - Raw user skills like ["Python", "React", "ML"]
 * @returns {Map<string, number>} keyword -> weight
 */
export function expandSkills(skills) {
  const expanded = new Map();

  for (const rawSkill of skills) {
    const skill = rawSkill.toLowerCase().trim();
    // Direct match weight
    expanded.set(skill, (expanded.get(skill) || 0) + 3.0);

    // Find taxonomy matches
    for (const [category, keywords] of Object.entries(SKILL_TAXONOMY)) {
      if (keywords.includes(skill) || category === skill) {
        const boost = RARITY_BOOST[category] || 1.0;
        for (const kw of keywords) {
          const weight = kw === skill ? 3.0 * boost : 0.8 * boost;
          expanded.set(kw, Math.max(expanded.get(kw) || 0, weight));
        }
      }
    }
  }

  return expanded;
}

/**
 * Score an opportunity against a user's expanded skill profile
 * @param {Object} opportunity - { title, company, source, url, deadline }
 * @param {Map<string, number>} expandedSkills - from expandSkills()
 * @returns {{ score: number, matchedKeywords: string[], relevancePct: number }}
 */
export function scoreOpportunity(opportunity, expandedSkills) {
  const text = `${opportunity.title || ''} ${opportunity.company || ''}`.toLowerCase();
  let score = 0;
  const matchedKeywords = [];

  for (const [keyword, weight] of expandedSkills) {
    if (text.includes(keyword)) {
      score += weight;
      if (weight >= 1.5) { // Only show significant matches
        matchedKeywords.push(keyword);
      }
    }
  }

  // Bonus: deadline approaching (urgency boost)
  if (opportunity.deadline) {
    const daysLeft = (new Date(opportunity.deadline) - new Date()) / (1000 * 60 * 60 * 24);
    if (daysLeft > 0 && daysLeft <= 7) score += 3; // Expires this week
    else if (daysLeft > 0 && daysLeft <= 30) score += 1;
  }

  // Bonus: reputable sources
  if (opportunity.source === 'Greenhouse') score += 1.5; // Top tech companies
  if (opportunity.source === 'Devpost') score += 0.5;

  // Intern/new-grad title boost
  const internKw = ['intern', 'internship', 'new grad', 'graduate', 'entry level', 'junior', 'fresher', '2027', '2026'];
  for (const kw of internKw) {
    if (text.includes(kw)) { score += 2; break; }
  }

  const maxPossibleScore = Math.max(...expandedSkills.values()) * 3 + 6;
  const relevancePct = Math.min(Math.round((score / maxPossibleScore) * 100), 99);

  return { score, matchedKeywords: [...new Set(matchedKeywords)], relevancePct };
}

/**
 * Rank and filter opportunities for a user profile
 */
export function rankOpportunities(opportunities, userSkills, opts = {}) {
  const { limit = 10, minScore = 0, source = null, category = null } = opts;
  const expanded = expandSkills(userSkills);

  let filtered = opportunities;

  // Source filter
  if (source && source !== 'all') {
    filtered = filtered.filter(o => o.source === source);
  }

  // Category filter
  if (category && category !== 'all') {
    const catKeywords = {
      tech: ['developer', 'development', 'engineering', 'software', 'data', 'full stack', 'frontend', 'backend', 'devops', 'ml', 'ai', 'seo', 'game', 'network', 'cloud', 'security'],
      business: ['sales', 'marketing', 'business', 'finance', 'content', 'client', 'management', 'growth'],
      design: ['design', 'graphic', 'ui', 'ux', 'creative', 'video', 'animation'],
      hr: ['hr', 'human resources', 'talent', 'recruitment', 'hiring'],
    };
    const kws = catKeywords[category] || [];
    if (kws.length > 0) {
      filtered = filtered.filter(o => {
        const t = `${o.title} ${o.company}`.toLowerCase();
        return kws.some(k => t.includes(k));
      });
    }
  }

  // Score and sort
  const scored = filtered.map(opp => {
    const { score, matchedKeywords, relevancePct } = scoreOpportunity(opp, expanded);
    return { ...opp, score, matchedKeywords, relevancePct };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.filter(o => o.score >= minScore).slice(0, limit);
}

/**
 * Generate a smart digest for the user
 */
export function generateDigest(opportunities, profile) {
  const skills = profile.skills || [];
  const expanded = expandSkills(skills);

  // 1. Top matches
  const topMatches = rankOpportunities(opportunities, skills, { limit: 5, minScore: 2 });

  // 2. Expiring soon (deadline within 7 days)
  const now = new Date();
  const expiringSoon = opportunities
    .filter(o => {
      if (!o.deadline) return false;
      const d = (new Date(o.deadline) - now) / (1000 * 60 * 60 * 24);
      return d > 0 && d <= 7;
    })
    .slice(0, 3);

  // 3. New since yesterday
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const newOpps = opportunities
    .filter(o => o.created_at && new Date(o.created_at) > yesterday)
    .slice(0, 5);

  // 4. Skill gap analysis — find popular opp keywords user doesn't have
  const oppKeywordFreq = {};
  for (const opp of opportunities.slice(0, 100)) {
    const text = `${opp.title}`.toLowerCase();
    for (const [category, keywords] of Object.entries(SKILL_TAXONOMY)) {
      for (const kw of keywords.slice(0, 3)) { // just primary keywords
        if (text.includes(kw) && !expanded.has(kw)) {
          oppKeywordFreq[category] = (oppKeywordFreq[category] || 0) + 1;
        }
      }
    }
  }
  const trendingSkills = Object.entries(oppKeywordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([skill, count]) => ({ skill, count }));

  // 5. Source breakdown for user's matches
  const sourceBreakdown = {};
  topMatches.forEach(m => {
    sourceBreakdown[m.source] = (sourceBreakdown[m.source] || 0) + 1;
  });

  return {
    topMatches,
    expiringSoon,
    newOpps,
    trendingSkills,
    sourceBreakdown,
    totalOpps: opportunities.length,
    profileStrength: skills.length >= 3 ? 'strong' : skills.length >= 1 ? 'moderate' : 'weak',
  };
}
