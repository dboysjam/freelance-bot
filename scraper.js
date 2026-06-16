const axios = require('axios');
const Parser = require('rss-parser');

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
  timeout: 10000,
});

const CACHE_DURATION = 15 * 60 * 1000;
let jobCache = [];
let lastFetch = 0;
let fetchInProgress = false;

// ─── WORKING RSS SOURCES ──────────────────────────────────
// These sites allow automated access via RSS feeds.
// Upwork was removed because they block scrapers.
const WORKING_SOURCES = [
  {
    name: 'Freelancer',
    icon: '⚪',
    url: 'https://www.freelancer.com/rss/feed.xml',
  },
  {
    name: 'We Work Remotely',
    icon: '🟠',
    url: 'https://weworkremotely.com/remote-jobs.rss',
  },
  {
    name: 'Remote OK',
    icon: '🟢',
    url: 'https://remoteok.com/rss',
  },
  {
    name: 'Dev.to Jobs',
    icon: '🟣',
    url: 'https://dev.to/feed/tag/jobs',
  },
];

function extractBudget(text = '') {
  const match = text.match(/\$[\d,]+(?:\.\d{2})?(?:\s*(?:-\s*\$[\d,]+(?:\.\d{2})?|k|K|\/hr|\/hour))?/i);
  return match ? match[0] : null;
}

function scrapeRSS(source) {
  return async () => {
    const jobs = [];
    try {
      const feed = await parser.parseURL(source.url);
      if (feed?.items) {
        for (const item of feed.items.slice(0, 12)) {
          const desc = item.contentSnippet || item.content || '';
          jobs.push({
            title: item.title?.trim() || 'Untitled',
            description: desc.substring(0, 300) || 'No description',
            url: item.link || '',
            source: source.name,
            icon: source.icon,
            budget: item.title?.match(/\$[\d,]+(?:k|K|\/hr)?/)?.[0]
              || extractBudget(desc)
              || 'N/A',
            skills: item.categories?.slice(0, 5) || [],
            posted: item.pubDate || item.isoDate || '',
          });
        }
      }
    } catch (e) {
      console.error(`❌ ${source.name}: ${e.message}`);
    }
    return jobs;
  };
}

// ─── ADZUNA API (FREE) ────────────────────────────────────
// Adzuna is a legit job API with free tier. Sign up at:
// https://developer.adzuna.com/
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || '';
const ADZUNA_API_KEY = process.env.ADZUNA_API_KEY || '';
const ADZUNA_ENABLED = !!(ADZUNA_APP_ID && ADZUNA_API_KEY);

async function scrapeAdzuna() {
  if (!ADZUNA_ENABLED) return [];
  const jobs = [];
  try {
    const { data } = await axios.get(
      `https://api.adzuna.com/v1/api/jobs/us/search/1`,
      {
        params: {
          app_id: ADZUNA_APP_ID,
          app_key: ADZUNA_API_KEY,
          results_per_page: 15,
          what: 'freelance',
          content_type: 'freelance',
          sort_by: 'relevance',
        },
        timeout: 10000,
      }
    );
    if (data?.results) {
      for (const job of data.results) {
        jobs.push({
          title: job.title || 'Untitled',
          description: (job.description || '').substring(0, 300),
          url: job.redirect_url || '',
          source: 'Adzuna',
          icon: '🔶',
          budget: job.salary_min
            ? `$${Math.round(job.salary_min).toLocaleString()}`
            : job.salary_is_predicted ? 'Est. salary' : 'N/A',
          skills: [job.category?.label || '', job.contract_type || ''].filter(Boolean),
          posted: job.created || '',
        });
      }
    }
  } catch (e) {
    console.error('❌ Adzuna:', e.message);
  }
  return jobs;
}

// ─── MAIN FETCH ────────────────────────────────────────────
async function fetchAllJobs(force = false) {
  const now = Date.now();
  if (!force && fetchInProgress) return [];
  if (!force && now - lastFetch < CACHE_DURATION) return jobCache;

  fetchInProgress = true;
  const allJobs = [];

  console.log('🔄 Fetching jobs from freelance sources...');

  // Run RSS scrapers in parallel
  const rssScrapers = WORKING_SOURCES.map(s => ({
    scrape: scrapeRSS(s),
    name: s.name,
    icon: s.icon,
  }));

  const results = await Promise.allSettled([
    ...rssScrapers.map(s => s.scrape()),
    ADZUNA_ENABLED ? scrapeAdzuna() : Promise.resolve([]),
  ]);

  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      allJobs.push(...result.value);
      if (i < rssScrapers.length) {
        console.log(`✅ ${rssScrapers[i].name}: ${result.value.length} jobs`);
      } else if (ADZUNA_ENABLED) {
        console.log(`✅ Adzuna: ${result.value.length} jobs`);
      }
    }
  });

  allJobs.sort((a, b) => {
    if (a.posted && b.posted) return new Date(b.posted) - new Date(a.posted);
    return 0;
  });

  jobCache = allJobs.slice(0, 50);
  lastFetch = now;
  fetchInProgress = false;

  console.log(`📊 Total: ${allJobs.length} jobs fetched`);
  return jobCache;
}

function searchJobs(query, jobs) {
  const q = query.toLowerCase();
  return jobs.filter(j =>
    j.title.toLowerCase().includes(q) ||
    j.description.toLowerCase().includes(q) ||
    j.skills.some(s => s.toLowerCase().includes(q)) ||
    j.source.toLowerCase().includes(q)
  );
}

function getJobsBySource(source, jobs) {
  return jobs.filter(j => j.source.toLowerCase() === source.toLowerCase());
}

module.exports = {
  fetchAllJobs,
  searchJobs,
  getJobsBySource,
  WORKING_SOURCES,
  ADZUNA_ENABLED,
};
