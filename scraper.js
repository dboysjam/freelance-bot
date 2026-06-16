const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  timeout: 10000,
});

const CACHE_DURATION = 15 * 60 * 1000; // 15 min cache

let jobCache = [];
let lastFetch = 0;
let fetchInProgress = false;

// ─── RSS SOURCES ───────────────────────────────────────────
const RSS_SOURCES = [
  {
    name: 'Upwork',
    url: 'https://www.upwork.com/ab/feed/jobs/rss?q=&sort=recency&paging=0&page=1',
    icon: '🔵',
    parse: (item) => ({
      title: item.title || 'N/A',
      description: item.contentSnippet?.substring(0, 300) || item.content?.substring(0, 300) || 'No description',
      url: item.link || '',
      source: 'Upwork',
      budget: item.title?.match(/\$[\d,]+/)?.[0] || 'N/A',
      skills: item.categories || [],
    }),
  },
  {
    name: 'Freelancer',
    url: 'https://www.freelancer.com/rss/feed.xml',
    icon: '⚪',
    parse: (item) => ({
      title: item.title || 'N/A',
      description: item.contentSnippet?.substring(0, 300) || 'No description',
      url: item.link || '',
      source: 'Freelancer',
      budget: item.title?.match(/\$[\d,]+/)?.[0] || 'N/A',
      skills: item.categories || [],
    }),
  },
  {
    name: 'We Work Remotely',
    url: 'https://weworkremotely.com/remote-jobs.rss',
    icon: '🟠',
    parse: (item) => ({
      title: item.title || 'N/A',
      description: item.contentSnippet?.substring(0, 300) || 'No description',
      url: item.link || '',
      source: 'We Work Remotely',
      budget: 'Salary listed',
      skills: [],
    }),
  },
  {
    name: 'Remote OK',
    url: 'https://remoteok.com/rss',
    icon: '🟢',
    parse: (item) => ({
      title: item.title || 'N/A',
      description: item.contentSnippet?.substring(0, 300) || item.content?.substring(0, 300) || 'No description',
      url: item.link || '',
      source: 'Remote OK',
      budget: item.title?.match(/\$[\d,]+(?:k|K)?/)?.[0] || 'N/A',
      skills: item.categories || [],
    }),
  },
  {
    name: 'Dev.to Jobs',
    url: 'https://dev.to/feed/tag/jobs',
    icon: '🟣',
    parse: (item) => ({
      title: item.title || 'N/A',
      description: item.contentSnippet?.substring(0, 300) || 'No description',
      url: item.link || '',
      source: 'Dev.to',
      budget: item.title?.match(/\$[\d,]+/)?.[0] || 'N/A',
      skills: item.categories || [],
    }),
  },
];

// ─── SCRAPE FUNCTIONS ──────────────────────────────────────

async function scrapeUpwork() {
  const jobs = [];
  try {
    const { data } = await axios.get('https://www.upwork.com/ab/feed/jobs/rss', {
      params: { q: '', sort: 'recency', paging: 0, page: 1 },
      timeout: 10000,
    });
    const feed = await parser.parseString(data);
    if (feed?.items) {
      for (const item of feed.items.slice(0, 10)) {
        jobs.push({
          title: item.title?.trim() || 'Untitled',
          description: item.contentSnippet?.substring(0, 300) || 'No description',
          url: item.link || '',
          source: 'Upwork',
          icon: '🔵',
          budget: item.title?.match(/\$[\d,]+(?:k|K)?/)?.[0] || extractBudget(item.contentSnippet) || 'N/A',
          skills: item.categories?.slice(0, 5) || [],
          posted: item.pubDate || item.isoDate || '',
        });
      }
    }
  } catch (e) { console.error('Upwork scrape failed:', e.message); }
  return jobs;
}

async function scrapeFreelancer() {
  const jobs = [];
  try {
    const { data } = await axios.get('https://www.freelancer.com/rss/feed.xml', { timeout: 10000 });
    const feed = await parser.parseString(data);
    if (feed?.items) {
      for (const item of feed.items.slice(0, 10)) {
        jobs.push({
          title: item.title?.trim() || 'Untitled',
          description: item.contentSnippet?.substring(0, 300) || 'No description',
          url: item.link || '',
          source: 'Freelancer',
          icon: '⚪',
          budget: item.title?.match(/\$[\d,]+(?:k|K)?/)?.[0] || extractBudget(item.contentSnippet) || 'N/A',
          skills: item.categories?.slice(0, 5) || [],
          posted: item.pubDate || item.isoDate || '',
        });
      }
    }
  } catch (e) { console.error('Freelancer scrape failed:', e.message); }
  return jobs;
}

async function scrapeWeWorkRemotely() {
  const jobs = [];
  try {
    const { data } = await axios.get('https://weworkremotely.com/remote-jobs.rss', { timeout: 10000 });
    const feed = await parser.parseString(data);
    if (feed?.items) {
      for (const item of feed.items.slice(0, 10)) {
        jobs.push({
          title: item.title?.trim() || 'Untitled',
          description: item.contentSnippet?.substring(0, 300) || 'No description',
          url: item.link || '',
          source: 'We Work Remotely',
          icon: '🟠',
          budget: item.title?.match(/\$[\d,]+(?:k|K)?/)?.[0] || extractBudget(item.contentSnippet) || 'Salary',
          skills: item.categories?.slice(0, 5) || [],
          posted: item.pubDate || item.isoDate || '',
        });
      }
    }
  } catch (e) { console.error('WWR scrape failed:', e.message); }
  return jobs;
}

async function scrapeRemoteOk() {
  const jobs = [];
  try {
    const { data } = await axios.get('https://remoteok.com/rss', { timeout: 10000 });
    const feed = await parser.parseString(data);
    if (feed?.items) {
      for (const item of feed.items.slice(0, 10)) {
        jobs.push({
          title: item.title?.trim() || 'Untitled',
          description: item.contentSnippet?.substring(0, 300) || 'No description',
          url: item.link || '',
          source: 'Remote OK',
          icon: '🟢',
          budget: item.title?.match(/\$[\d,]+(?:k|K)?/)?.[0] || extractBudget(item.contentSnippet) || 'N/A',
          skills: item.categories?.slice(0, 5) || [],
          posted: item.pubDate || item.isoDate || '',
        });
      }
    }
  } catch (e) { console.error('RemoteOK scrape failed:', e.message); }
  return jobs;
}

async function scrapeDevTo() {
  const jobs = [];
  try {
    const { data } = await axios.get('https://dev.to/feed/tag/jobs', { timeout: 10000 });
    const feed = await parser.parseString(data);
    if (feed?.items) {
      for (const item of feed.items.slice(0, 10)) {
        jobs.push({
          title: item.title?.trim() || 'Untitled',
          description: item.contentSnippet?.substring(0, 300) || 'No description',
          url: item.link || '',
          source: 'Dev.to Jobs',
          icon: '🟣',
          budget: item.title?.match(/\$[\d,]+(?:k|K)?/)?.[0] || 'N/A',
          skills: item.categories?.slice(0, 5) || [],
          posted: item.pubDate || item.isoDate || '',
        });
      }
    }
  } catch (e) { console.error('Dev.to scrape failed:', e.message); }
  return jobs;
}

// ─── FALLBACK: scrape Upwork HTML directly ─────────────────
async function scrapeUpworkDirect() {
  const jobs = [];
  try {
    const { data } = await axios.get('https://www.upwork.com/nx/search/jobs/', {
      params: { q: 'freelance', sort: 'recency', page: 1 },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 10000,
    });
    const $ = cheerio.load(data);
    $('article, .job-tile, [data-test="job-tile"]').each((i, el) => {
      if (i >= 5) return;
      const title = $(el).find('h2, h3, a').first().text().trim();
      const desc = $(el).find('p').first().text().trim().substring(0, 200);
      const link = $(el).find('a').first().attr('href') || '';
      const budget = $(el).find('[data-test="budget"]').text().trim() || $(el).text().match(/\$[\d,]+(?:k|K)?/)?.[0] || '';
      if (title) {
        jobs.push({
          title,
          description: desc || 'Click to view details',
          url: link.startsWith('http') ? link : `https://www.upwork.com${link}`,
          source: 'Upwork',
          icon: '🔵',
          budget: budget || 'N/A',
          skills: [],
          posted: '',
        });
      }
    });
  } catch (e) { console.error('Upwork direct scrape failed:', e.message); }
  return jobs;
}

function extractBudget(text = '') {
  const match = text.match(/\$[\d,]+(?:\.\d{2})?(?:\s*(?:-\s*\$[\d,]+(?:\.\d{2})?|k|K))?/);
  return match ? match[0] : null;
}

// ─── MODIFIED SCRAPER: sites NOT blocked ───────────────────
// Many sites block automated requests. Here are ones that work:
const WORKING_SOURCES = [
  {
    name: 'Upwork',
    icon: '🔵',
    scrape: scrapeUpworkDirect,
  },
  {
    name: 'Freelancer',
    icon: '⚪',
    scrape: scrapeFreelancer,
  },
  {
    name: 'We Work Remotely',
    icon: '🟠',
    scrape: scrapeWeWorkRemotely,
  },
  {
    name: 'Remote OK',
    icon: '🟢',
    scrape: scrapeRemoteOk,
  },
  {
    name: 'Dev.to Jobs',
    icon: '🟣',
    scrape: scrapeDevTo,
  },
];

// ─── MAIN FETCH ────────────────────────────────────────────
async function fetchAllJobs(force = false) {
  const now = Date.now();
  if (!force && fetchInProgress) return [];
  if (!force && now - lastFetch < CACHE_DURATION) return jobCache;

  fetchInProgress = true;
  const allJobs = [];

  console.log('🔄 Fetching jobs from freelance sites...');

  // Run all scrapers in parallel
  const results = await Promise.allSettled(
    WORKING_SOURCES.map(s => s.scrape())
  );

  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      const source = WORKING_SOURCES[i];
      const jobs = result.value.map(j => ({ ...j, source: source.name, icon: source.icon }));
      allJobs.push(...jobs);
      console.log(`✅ ${source.name}: ${jobs.length} jobs`);
    } else if (result.status === 'rejected') {
      console.error(`❌ ${WORKING_SOURCES[i].name}: ${result.reason?.message || 'failed'}`);
    }
  });

  // Sort by most recent
  allJobs.sort((a, b) => {
    if (a.posted && b.posted) return new Date(b.posted) - new Date(a.posted);
    return 0;
  });

  jobCache = allJobs.slice(0, 50); // keep max 50
  lastFetch = now;
  fetchInProgress = false;

  console.log(`📊 Total: ${allJobs.length} jobs fetched`);
  return jobCache;
}

// ─── SEARCH ─────────────────────────────────────────────────
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
};
