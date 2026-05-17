import { createClient } from '@supabase/supabase-js';
import './style.css';

// ─── Supabase Config ───
// These will be replaced with your actual values
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  document.getElementById('app').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#e4e7f1;font-family:Inter,sans-serif;flex-direction:column;gap:12px;">
      <h2>⚠️ Missing Supabase Config</h2>
      <p style="color:#8b90a5;">Create <code>web/.env</code> with VITE_SUPABASE_URL and VITE_SUPABASE_KEY</p>
    </div>`;
  document.getElementById('loader').style.display = 'none';
  throw new Error('Missing Supabase env vars');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── DOM Refs ───
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const loader = $('#loader');
const authScreen = $('#auth-screen');
const dashScreen = $('#dashboard-screen');
const authForm = $('#auth-form');
const authEmail = $('#auth-email');
const authPassword = $('#auth-password');
const authError = $('#auth-error');
const authSuccess = $('#auth-success');
const authBtnText = $('#auth-btn-text');
const authBtnSpinner = $('#auth-btn-spinner');
const magicLinkBtn = $('#magic-link-btn');

let currentAuthMode = 'login'; // 'login' or 'signup'
let allOpportunities = []; // cached

// ─── Auth Tab Switching ───
$$('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentAuthMode = tab.dataset.tab;
    authBtnText.textContent = currentAuthMode === 'login' ? 'Sign In' : 'Create Account';
    hideMessages();
  });
});

// ─── Auth Form Submit ───
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessages();
  setAuthLoading(true);

  const email = authEmail.value.trim();
  const password = authPassword.value;

  try {
    if (currentAuthMode === 'signup') {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      showSuccess('Check your email for a confirmation link!');
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    showError(err.message);
  } finally {
    setAuthLoading(false);
  }
});

// ─── Magic Link ───
magicLinkBtn.addEventListener('click', async () => {
  const email = authEmail.value.trim();
  if (!email) return showError('Enter your email first');
  hideMessages();

  try {
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) throw error;
    showSuccess('Magic link sent! Check your email.');
  } catch (err) {
    showError(err.message);
  }
});

// ─── Auth State Listener ───
supabase.auth.onAuthStateChange(async (event, session) => {
  loader.style.display = 'none';
  if (session) {
    authScreen.style.display = 'none';
    dashScreen.style.display = 'flex';
    await initDashboard(session.user);
  } else {
    authScreen.style.display = 'flex';
    dashScreen.style.display = 'none';
  }
});

// ─── Init check ───
(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  loader.style.display = 'none';
  if (session) {
    authScreen.style.display = 'none';
    dashScreen.style.display = 'flex';
    await initDashboard(session.user);
  } else {
    authScreen.style.display = 'flex';
  }
})();

// ─── Logout ───
$('#logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut();
});

// ─── Sidebar Navigation ───
$$('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    $$('.page').forEach(p => p.classList.remove('active'));
    $(`#page-${item.dataset.page}`).classList.add('active');
  });
});

$('#sidebar-toggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
});

$('#view-all-opps')?.addEventListener('click', () => {
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="opportunities"]').classList.add('active');
  $$('.page').forEach(p => p.classList.remove('active'));
  $('#page-opportunities').classList.add('active');
});

// ─── Dashboard Init ───
async function initDashboard(user) {
  const email = user.email || 'User';
  $('#user-email-display').textContent = email;
  $('#profile-email-display').textContent = email;
  $('#profile-avatar-letter').textContent = email[0].toUpperCase();
  $('#topbar-greeting').textContent = `Welcome, ${email.split('@')[0]}`;
  $('#profile-meta').textContent = `Member since ${new Date(user.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  // Ensure user exists in our users table
  await ensureUserRecord(user);

  // Load data
  await Promise.all([loadStats(), loadAllOpportunities(), loadProfile(user)]);

  // Setup filters
  setupFilters();
  setupSearch();
}

async function ensureUserRecord(user) {
  try {
    const { data } = await supabase
      .from('users')
      .select('id')
      .eq('email', user.email)
      .single();

    if (!data) {
      await supabase.from('users').insert([{ email: user.email }]);
    }
  } catch {
    // ignore — RLS or already exists
  }
}

// ─── Load Stats ───
async function loadStats() {
  try {
    const { data, error } = await supabase.from('opportunities').select('source');
    if (error) throw error;

    const total = data.length;
    const sources = {};
    data.forEach(d => { sources[d.source] = (sources[d.source] || 0) + 1; });

    const internCount = (sources['Internshala'] || 0) + (sources['Greenhouse'] || 0);
    const hackCount = (sources['Devfolio'] || 0) + (sources['Devpost'] || 0);

    $('#stat-total').textContent = total;
    $('#stat-internships').textContent = internCount;
    $('#stat-hackathons').textContent = hackCount;
    $('#stat-sources').textContent = Object.keys(sources).length;

    // Source chart
    const chartEl = $('#source-chart');
    const colors = { Devfolio: '#6c63ff', Devpost: '#34d399', Internshala: '#fb923c', Greenhouse: '#f472b6' };
    const maxCount = Math.max(...Object.values(sources), 1);

    chartEl.innerHTML = Object.entries(sources)
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => `
        <div class="chart-bar-row">
          <span class="chart-label">${source}</span>
          <div class="chart-bar-track">
            <div class="chart-bar" style="width:${(count / maxCount) * 100}%;background:${colors[source] || '#6c63ff'}">${count}</div>
          </div>
        </div>
      `).join('');
  } catch {
    $('#stat-total').textContent = '—';
  }
}

// ─── Load All Opportunities ───
async function loadAllOpportunities() {
  try {
    const { data, error } = await supabase
      .from('opportunities')
      .select('title, company, url, source, deadline, created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;
    allOpportunities = data || [];

    // Latest 5 for overview
    renderOppsList($('#latest-opps-list'), allOpportunities.slice(0, 5));

    // Full table
    renderOppsTable($('#all-opps-list'), allOpportunities);

    // Internships
    const interns = allOpportunities.filter(o => ['Internshala', 'Greenhouse'].includes(o.source));
    renderOppsTable($('#internships-list'), interns);

    // Hackathons
    const hacks = allOpportunities.filter(o => ['Devfolio', 'Devpost'].includes(o.source));
    renderOppsTable($('#hackathons-list'), hacks);
  } catch {
    $('#latest-opps-list').innerHTML = '<p class="empty-state">Failed to load</p>';
  }
}

function renderOppsList(container, items) {
  if (!items.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>No opportunities yet</p></div>';
    return;
  }
  container.innerHTML = items.map(o => `
    <div class="opp-item">
      <div>
        <div class="opp-title"><a href="${o.url}" target="_blank">${esc(o.title)}</a></div>
        <div class="opp-meta">${esc(o.company)}</div>
      </div>
      <span class="opp-source">${o.source}</span>
    </div>
  `).join('');
}

function renderOppsTable(container, items) {
  if (!items.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>No results</p></div>';
    return;
  }
  container.innerHTML = `
    <table class="opps-table">
      <thead><tr><th>Title</th><th>Company</th><th>Source</th><th>Deadline</th></tr></thead>
      <tbody>
        ${items.map(o => `
          <tr>
            <td><a href="${o.url}" target="_blank">${esc(o.title)}</a></td>
            <td>${esc(o.company)}</td>
            <td><span class="opp-source">${o.source}</span></td>
            <td>${o.deadline ? new Date(o.deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

// ─── Filters ───
function setupFilters() {
  // All opportunities filter
  $('#filter-source').addEventListener('change', applyAllOppsFilter);
  $('#filter-keyword').addEventListener('input', applyAllOppsFilter);

  // Internship filters
  $('#intern-source-filter').addEventListener('change', applyInternFilter);
  $('#intern-category-filter').addEventListener('change', applyInternFilter);
}

function applyAllOppsFilter() {
  const source = $('#filter-source').value;
  const kw = $('#filter-keyword').value.toLowerCase();
  let filtered = allOpportunities;
  if (source !== 'all') filtered = filtered.filter(o => o.source === source);
  if (kw) filtered = filtered.filter(o => (o.title + o.company).toLowerCase().includes(kw));
  renderOppsTable($('#all-opps-list'), filtered);
}

function applyInternFilter() {
  const source = $('#intern-source-filter').value;
  const cat = $('#intern-category-filter').value;
  const catKeywords = {
    tech: ['developer', 'development', 'engineering', 'software', 'data', 'full stack', 'frontend', 'backend', 'devops', 'ml', 'ai', 'seo', 'game', 'network'],
    business: ['sales', 'marketing', 'business', 'finance', 'content', 'client', 'management'],
    design: ['design', 'graphic', 'ui', 'ux', 'creative', 'video', 'animation'],
    hr: ['hr', 'human resources', 'talent', 'recruitment', 'hiring']
  };

  let filtered = allOpportunities.filter(o => ['Internshala', 'Greenhouse'].includes(o.source));
  if (source !== 'all') filtered = filtered.filter(o => o.source === source);
  if (cat !== 'all') {
    const kws = catKeywords[cat] || [];
    filtered = filtered.filter(o => kws.some(k => (o.title + o.company).toLowerCase().includes(k)));
  }
  renderOppsTable($('#internships-list'), filtered);
}

// ─── Global Search ───
function setupSearch() {
  $('#global-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    if (!q) return;
    // Switch to opportunities page and filter
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('[data-page="opportunities"]').classList.add('active');
    $$('.page').forEach(p => p.classList.remove('active'));
    $('#page-opportunities').classList.add('active');
    const filtered = allOpportunities.filter(o => (o.title + o.company + o.source).toLowerCase().includes(q));
    renderOppsTable($('#all-opps-list'), filtered);
  });
}

// ─── Profile ───
async function loadProfile(user) {
  try {
    const { data: u } = await supabase.from('users').select('id').eq('email', user.email).single();
    if (!u) return;

    const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', u.id).single();
    if (profile) {
      $('#profile-skills').value = profile.skills?.join(', ') || '';
      $('#profile-batch').value = profile.batch_year || '';
      $('#profile-cgpa').value = profile.cgpa || '';
    }
  } catch { /* no profile yet */ }
}

$('#save-profile-btn').addEventListener('click', async () => {
  const msg = $('#profile-save-msg');
  msg.style.display = 'none';

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Ensure user row
    let { data: u } = await supabase.from('users').select('id').eq('email', user.email).single();
    if (!u) {
      const { data: nu } = await supabase.from('users').insert([{ email: user.email }]).select('id').single();
      u = nu;
    }

    const skills = $('#profile-skills').value.split(',').map(s => s.trim()).filter(Boolean);
    const batch = parseInt($('#profile-batch').value) || null;
    const cgpa = parseFloat($('#profile-cgpa').value) || null;

    const { error } = await supabase.from('profiles').upsert({
      user_id: u.id,
      skills,
      batch_year: batch,
      cgpa
    });

    if (error) throw error;
    msg.textContent = '✅ Profile saved!';
    msg.style.display = 'block';
  } catch (err) {
    msg.textContent = '❌ ' + err.message;
    msg.style.color = '#ef4444';
    msg.style.display = 'block';
  }
});

// ─── Helpers ───
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function showError(msg) { authError.textContent = msg; authError.style.display = 'block'; }
function showSuccess(msg) { authSuccess.textContent = msg; authSuccess.style.display = 'block'; }
function hideMessages() { authError.style.display = 'none'; authSuccess.style.display = 'none'; }
function setAuthLoading(v) {
  authBtnText.style.display = v ? 'none' : 'inline';
  authBtnSpinner.style.display = v ? 'inline-block' : 'none';
}
