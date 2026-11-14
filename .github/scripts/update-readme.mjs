#!/usr/bin/env node

/**
 * Daily README updater for yangyang0507.
 *
 * Updates two marker-delimited sections in README.md using only the GitHub REST API
 * (zero third-party card services, zero npm dependencies):
 *   1. <!-- OPEN_SOURCE:START --> ... <!-- OPEN_SOURCE:END -->
 *   2. <!-- WORKING_ON:START --> ... <!-- WORKING_ON:END -->
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const USERNAME = process.env.GH_USERNAME || 'yangyang0507';
const TRACKED_ORGS = ['agi-fans'];
const EXTRA_TRACKED_REPOS = ['baomidou/mybatis-plus'];
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const ACTIVE_WINDOW_DAYS = 90;
const MAX_ACTIVE_REPOS = 5;
const AUTO_DISCOVER_CREATED_AFTER = '2026-11-15T00:00:00Z';

// Repositories never shown in auto-discovered projects or "Currently Working On"
const EXCLUDED_REPOS = new Set([
  `${USERNAME}/${USERNAME}`,
  `${USERNAME}/${USERNAME}.github.io`,
  `${USERNAME}/blog`,
  `${USERNAME}/res`,
  'agi-fans/agi.fans',
  'devote-team/.github',
]);

// Curated core open-source projects (order preserved; live stars & language synced daily)
const FEATURED_PROJECTS = [
  {
    repo: 'agi-fans/oh-my-dsh',
    name: 'oh-my-dsh',
    description: 'Keyboard-first TUI companion for DeepSeek Harness (`omdsh`)',
  },
  {
    repo: 'agi-fans/dsh-better',
    name: 'dsh-better',
    description: 'Codebase-grounded `/better` prompt deepening & subagent verification for DSH',
  },
  {
    repo: 'yangyang0507/starepo',
    name: 'starepo',
    description: 'Semantic search over your GitHub stars',
  },
  {
    repo: 'yangyang0507/pi-wechat',
    name: 'pi-wechat',
    description: 'WeChat channel integration for Pi coding agents',
  },
  {
    repo: 'yangyang0507/claude-agent-sdk-ui',
    name: 'claude-agent-sdk-ui',
    description: 'Declarative terminal UI framework for Claude Agent SDK (React + Ink)',
  },
  {
    repo: 'yangyang0507/pi-zenmux',
    name: 'pi-zenmux',
    description: 'ZenMux model provider extension for Pi',
  },
  {
    repo: 'yangyang0507/herdr-skill',
    name: 'herdr-skill',
    description: 'Streamlined agent skill workflow for Herdr',
  },
  {
    repo: 'baomidou/mybatis-plus',
    name: 'mybatis-plus',
    description: 'Enhanced MyBatis toolkit for simplified Java development *(org admin)*',
  },
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.resolve(__dirname, '../../README.md');

async function ghFetch(endpoint, { allow404 = false } = {}) {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://api.github.com${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${USERNAME}-readme-updater`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 404 && allow404) {
        return null;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status} on ${endpoint}: ${body.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
  }
  throw lastErr;
}

function formatStars(count) {
  if (typeof count !== 'number' || Number.isNaN(count)) return '-';
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(count);
}

function formatDateCST(isoString) {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function cleanText(text, maxLen = 78) {
  if (!text) return '';
  const singleLine = text
    .split('\n')[0]
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]+/u, '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated =
    singleLine.length <= maxLen
      ? singleLine
      : `${singleLine.slice(0, maxLen - 1).trimEnd()}…`;
  return truncated.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function isBoilerplateCommitMessage(msg) {
  const firstLine = (msg || '').split('\n')[0].trim();
  // Strip leading gitmoji / emoji for pattern matching
  const normalized = firstLine.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]+/u, '');
  return (
    /^merge\s+(pull request|branch|remote-tracking)/i.test(normalized) ||
    /^chore\((release|deps|version)\):/i.test(normalized) ||
    /^ci\(release\):/i.test(normalized) ||
    /^chore:\s*(bump|release|prepare)\b/i.test(normalized) ||
    /\bbump version\b/i.test(normalized) ||
    /^release[:\s]+v?\d+\.\d+/i.test(normalized) ||
    /^v?\d+\.\d+\.\d+(-[\w.]+)?$/.test(normalized) ||
    /^发布\s*v?\d+\.\d+/.test(normalized)
  );
}

function replaceBetweenMarkers(markdown, markerName, newContent) {
  const startMarker = `<!-- ${markerName}:START -->`;
  const endMarker = `<!-- ${markerName}:END -->`;
  const startIdx = markdown.indexOf(startMarker);
  const endIdx = markdown.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Markers ${startMarker} ... ${endMarker} not found in README.md`);
  }
  return (
    markdown.slice(0, startIdx + startMarker.length) +
    '\n' +
    newContent.trim() +
    '\n' +
    markdown.slice(endIdx)
  );
}

const repoMetaCache = new Map();
async function getPublicRepoMeta(fullName) {
  if (repoMetaCache.has(fullName)) return repoMetaCache.get(fullName);
  const data = await ghFetch(`/repos/${fullName}`, { allow404: true }).catch(() => null);
  if (!data || data.private || data.visibility === 'private') {
    repoMetaCache.set(fullName, null);
    return null;
  }
  repoMetaCache.set(fullName, data);
  return data;
}

async function discoverOwnedAndOrgPublicRepos() {
  const lists = await Promise.all([
    ghFetch(`/users/${USERNAME}/repos?type=owner&sort=pushed&per_page=40`).catch(() => []),
    ...TRACKED_ORGS.map((org) =>
      ghFetch(`/orgs/${org}/repos?type=public&sort=pushed&per_page=40`).catch(() => [])
    ),
  ]);
  const repos = [];
  for (const list of lists) {
    for (const r of list || []) {
      if (!r || r.private || r.visibility === 'private') continue;
      repoMetaCache.set(r.full_name, r);
      repos.push(r);
    }
  }
  return repos;
}

async function buildOpenSourceTable(discoveredRepos) {
  const featuredSet = new Set(FEATURED_PROJECTS.map((p) => p.repo.toLowerCase()));
  const entries = [...FEATURED_PROJECTS];

  // Automatically surface brand-new public original repos created in the future with a description
  const newlyCreated = discoveredRepos
    .filter(
      (r) =>
        !r.fork &&
        !r.archived &&
        !EXCLUDED_REPOS.has(r.full_name) &&
        !featuredSet.has(r.full_name.toLowerCase()) &&
        r.description &&
        r.description.trim().length > 0 &&
        r.created_at > AUTO_DISCOVER_CREATED_AFTER
    )
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  for (const r of newlyCreated) {
    entries.unshift({
      repo: r.full_name,
      name: r.name,
      description: r.description.trim(),
    });
  }

  const rowResults = await Promise.all(
    entries.map(async (item) => {
      const meta = await getPublicRepoMeta(item.repo);
      if (!meta) return null;
      const url = meta.html_url || `https://github.com/${item.repo}`;
      const lang = meta.language || '-';
      const stars = formatStars(meta.stargazers_count);
      const desc = (item.description || meta.description || '-').replace(/\|/g, '/').trim();
      return `| **[${item.name}](${url})** | ${desc} | ${lang} | ${stars} |`;
    })
  );
  const rows = rowResults.filter(Boolean);

  if (rows.length === 0) {
    throw new Error('No open-source project rows were generated');
  }

  return [
    '| Project | Description | Lang | Stars |',
    '| :--- | :--- | :--- | ---: |',
    ...rows,
  ].join('\n');
}

async function buildWorkingOnList(discoveredRepos) {
  // Map of full_name -> candidate signals
  const candidates = new Map();

  const ensureCandidate = (fullName) => {
    if (EXCLUDED_REPOS.has(fullName)) return null;
    if (!candidates.has(fullName)) {
      candidates.set(fullName, {
        fullName,
        lastEventAt: null,
        latestPr: null,
      });
    }
    return candidates.get(fullName);
  };

  // 1. Recent public events (catches pushes, releases, PRs across any public org/repo)
  const eventPages = await Promise.all(
    [1, 2, 3].map((page) =>
      ghFetch(`/users/${USERNAME}/events/public?per_page=100&page=${page}`).catch(() => [])
    )
  );
  const activeEventTypes = new Set(['PushEvent', 'ReleaseEvent', 'PullRequestEvent', 'CreateEvent']);
  for (const events of eventPages) {
    for (const ev of events || []) {
      if (!ev || !ev.public || !activeEventTypes.has(ev.type)) continue;
      if (ev.actor?.login?.toLowerCase() !== USERNAME.toLowerCase()) continue;
      const repoName = ev.repo?.name;
      if (!repoName) continue;
      const c = ensureCandidate(repoName);
      if (!c) continue;
      if (!c.lastEventAt || ev.created_at > c.lastEventAt) {
        c.lastEventAt = ev.created_at;
      }
    }
  }

  // 2. Owned + tracked org non-fork public repos + extra tracked repos
  for (const r of discoveredRepos) {
    if (r.fork || r.archived) continue;
    ensureCandidate(r.full_name);
  }
  for (const fullName of EXTRA_TRACKED_REPOS) {
    ensureCandidate(fullName);
  }

  // 3. Recent public PRs authored by USERNAME (surfaces upstream OSS contributions)
  const prSearch = await ghFetch(
    `/search/issues?q=author:${encodeURIComponent(USERNAME)}+type:pr+is:public&sort=updated&order=desc&per_page=15`
  ).catch(() => ({ items: [] }));

  for (const pr of prSearch?.items || []) {
    const repoName = (pr.repository_url || '').replace('https://api.github.com/repos/', '');
    if (!repoName) continue;
    const c = ensureCandidate(repoName);
    if (!c) continue;
    if (!c.latestPr || pr.updated_at > c.latestPr.updatedAt) {
      c.latestPr = {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        state: pr.state,
        updatedAt: pr.created_at || pr.updated_at,
      };
    }
  }

  // Sort candidate pool by rough recency before inspecting top candidates in detail
  const sortedNames = [...candidates.keys()].sort((a, b) => {
    const ca = candidates.get(a);
    const cb = candidates.get(b);
    const metaA = repoMetaCache.get(a);
    const metaB = repoMetaCache.get(b);
    const timeA = ca.lastEventAt || ca.latestPr?.updatedAt || metaA?.pushed_at || '';
    const timeB = cb.lastEventAt || cb.latestPr?.updatedAt || metaB?.pushed_at || '';
    return timeB.localeCompare(timeA);
  });

  // Inspect top 14 candidates in parallel for exact author commits & releases
  const rawInspected = await Promise.all(
    sortedNames.slice(0, 14).map(async (fullName) => {
      const meta = await getPublicRepoMeta(fullName);
      if (!meta || meta.archived) return null;
      const cand = candidates.get(fullName);
      if (meta.fork && !cand.latestPr) return null;

      const [commits, latestRelease] = await Promise.all([
        ghFetch(`/repos/${fullName}/commits?author=${encodeURIComponent(USERNAME)}&per_page=10`, {
          allow404: true,
        }).catch(() => []),
        ghFetch(`/repos/${fullName}/releases/latest`, { allow404: true }).catch(() => null),
      ]);

      const commitList = Array.isArray(commits) ? commits : [];
      const newestCommit = commitList[0] || null;
      const substantiveCommit =
        commitList.find((c) => !isBoilerplateCommitMessage(c?.commit?.message)) || newestCommit;

      const newestCommitDate = newestCommit?.commit?.author?.date || null;
      const releaseByUser =
        latestRelease &&
        !latestRelease.draft &&
        latestRelease.author?.login?.toLowerCase() === USERNAME.toLowerCase();
      const releaseDate = latestRelease?.published_at || null;

      const timestamps = [
        newestCommitDate,
        releaseByUser ? releaseDate : null,
        cand.latestPr?.updatedAt || null,
        cand.lastEventAt,
      ].filter(Boolean);

      if (timestamps.length === 0) return null;
      timestamps.sort();
      const lastActiveAt = timestamps[timestamps.length - 1];

      let headline = null;
      if (
        cand.latestPr &&
        (!newestCommitDate || cand.latestPr.updatedAt > newestCommitDate)
      ) {
        headline = {
          text: `PR #${cand.latestPr.number}: ${cleanText(cand.latestPr.title, 72)}`,
          url: cand.latestPr.url,
        };
      } else if (substantiveCommit) {
        headline = {
          text: cleanText(substantiveCommit.commit?.message, 76),
          url: substantiveCommit.html_url,
        };
      } else if (cand.latestPr) {
        headline = {
          text: `PR #${cand.latestPr.number}: ${cleanText(cand.latestPr.title, 72)}`,
          url: cand.latestPr.url,
        };
      }

      let releaseTag = null;
      if (latestRelease?.tag_name && latestRelease?.html_url && releaseDate) {
        const ageDiffDays =
          Math.abs(new Date(lastActiveAt).getTime() - new Date(releaseDate).getTime()) /
          (1000 * 60 * 60 * 24);
        if (releaseByUser || ageDiffDays <= 60) {
          releaseTag = {
            tag: latestRelease.tag_name,
            url: latestRelease.html_url,
          };
        }
      }

      return {
        fullName,
        name: meta.name,
        owner: meta.owner?.login || fullName.split('/')[0],
        repoUrl: meta.html_url,
        description: meta.description || '',
        lastActiveAt,
        releaseTag,
        headline,
      };
    })
  );
  const inspected = rawInspected.filter(Boolean);

  inspected.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

  const cutoffIso = new Date(
    Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let selected = inspected.filter((item) => item.lastActiveAt >= cutoffIso).slice(0, MAX_ACTIVE_REPOS);
  if (selected.length < 3) {
    selected = inspected.slice(0, Math.min(3, inspected.length));
  }

  if (selected.length === 0) {
    throw new Error('No active repositories found');
  }

  return selected
    .map((item) => {
      const displayName =
        item.owner.toLowerCase() === USERNAME.toLowerCase() ? item.name : item.fullName;
      const releasePart = item.releaseTag
        ? ` · [\`${item.releaseTag.tag}\`](${item.releaseTag.url})`
        : '';
      const detailPart = item.headline
        ? ` — [${item.headline.text}](${item.headline.url})`
        : item.description
          ? ` — ${cleanText(item.description, 72)}`
          : '';
      const dateStr = formatDateCST(item.lastActiveAt);
      return `- **[${displayName}](${item.repoUrl})**${releasePart}${detailPart} *(${dateStr})*`;
    })
    .join('\n');
}

async function main() {
  const originalReadme = await readFile(README_PATH, 'utf8');
  let updatedReadme = originalReadme;

  const discoveredRepos = await discoverOwnedAndOrgPublicRepos();

  try {
    const openSourceMd = await buildOpenSourceTable(discoveredRepos);
    updatedReadme = replaceBetweenMarkers(updatedReadme, 'OPEN_SOURCE', openSourceMd);
    console.log('Updated OPEN_SOURCE section.');
  } catch (err) {
    console.warn(`::warning::Skipping OPEN_SOURCE update: ${err.message}`);
  }

  try {
    const workingOnMd = await buildWorkingOnList(discoveredRepos);
    updatedReadme = replaceBetweenMarkers(updatedReadme, 'WORKING_ON', workingOnMd);
    console.log('Updated WORKING_ON section.');
  } catch (err) {
    console.warn(`::warning::Skipping WORKING_ON update: ${err.message}`);
  }

  if (updatedReadme !== originalReadme) {
    await writeFile(README_PATH, updatedReadme, 'utf8');
    console.log('README.md updated.');
  } else {
    console.log('README.md is already up to date.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
