const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const DEFAULT_BASE_URL = "https://cpcfinder.com/api";
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_OUTPUT_DIR = path.join("out", "cpcfinder");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeText(value) {
  return `${value || ""}`.trim().replace(/\s+/g, " ");
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(`${value || ""}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function createApiUrl(baseUrl, endpoint, query) {
  const sanitizedBase = `${baseUrl}`.replace(/\/+$/, "");
  const sanitizedEndpoint = `${endpoint}`.replace(/^\/+/, "");
  const url = new URL(`${sanitizedBase}/${sanitizedEndpoint}`);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && `${value}`.length > 0) {
        url.searchParams.set(key, `${value}`);
      }
    }
  }
  return url.toString();
}

async function fetchJson(url) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node.js 18+.");
  }
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) {
    return [];
  }

  const limit = Math.max(1, Math.min(parsePositiveInteger(concurrency) || 1, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < limit; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function normalizeUrlForMatch(input) {
  const raw = `${input || ""}`.trim();
  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }

  const host = parsed.host.toLowerCase();
  let pathname = parsed.pathname || "/";
  pathname = pathname.replace(/\/+$/, "");
  if (!pathname) {
    pathname = "/";
  }
  pathname = pathname.toLowerCase();

  const queryPairs = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    queryPairs.push([key.toLowerCase(), value]);
  }
  queryPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const query = queryPairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  return `${parsed.protocol.toLowerCase()}//${host}${pathname}${query ? `?${query}` : ""}`;
}

async function fetchContestList(baseUrl, pageSize) {
  const firstPagePayload = await fetchJson(
    createApiUrl(baseUrl, "contest", {
      current: 1,
      pageSize,
    }),
  );

  const firstData = asArray(firstPagePayload && firstPagePayload.data);
  const pagesRaw = firstPagePayload && firstPagePayload.pagination ? firstPagePayload.pagination.pages : 1;
  const totalPages = Math.max(1, parsePositiveInteger(pagesRaw) || 1);

  const otherPages = [];
  for (let page = 2; page <= totalPages; page += 1) {
    otherPages.push(page);
  }

  const pagePayloads = await mapWithConcurrency(otherPages, 4, async (page) =>
    fetchJson(
      createApiUrl(baseUrl, "contest", {
        current: page,
        pageSize,
      }),
    ),
  );

  const contests = [...firstData];
  for (const payload of pagePayloads) {
    contests.push(...asArray(payload && payload.data));
  }

  const byContestId = new Map();
  for (const contest of contests) {
    const contestId = parsePositiveInteger(contest && contest.contestId);
    if (!contestId) {
      continue;
    }
    byContestId.set(contestId, contest);
  }

  const deduplicated = [...byContestId.values()].sort(
    (a, b) => parsePositiveInteger(b.contestId) - parsePositiveInteger(a.contestId),
  );

  return {
    contests: deduplicated,
    pagination: firstPagePayload && firstPagePayload.pagination ? firstPagePayload.pagination : null,
  };
}

function contestIdFromEntry(entry) {
  return parsePositiveInteger(entry && entry.contestId);
}

async function crawlCpcfinder(options) {
  const baseUrl = `${(options && options.baseUrl) || DEFAULT_BASE_URL}`.trim() || DEFAULT_BASE_URL;
  const outputDir = path.resolve((options && options.outputDir) || DEFAULT_OUTPUT_DIR);
  const concurrency = parsePositiveInteger(options && options.concurrency) || DEFAULT_CONCURRENCY;
  const pageSize = parsePositiveInteger(options && options.pageSize) || DEFAULT_PAGE_SIZE;

  ensureDir(outputDir);
  ensureDir(path.join(outputDir, "contests"));
  ensureDir(path.join(outputDir, "awards"));

  const fetchedList = await fetchContestList(baseUrl, pageSize);
  const contests = fetchedList.contests;

  writeJson(path.join(outputDir, "contest-list.raw.json"), {
    generatedAt: new Date().toISOString(),
    baseUrl,
    pageSize,
    pagination: fetchedList.pagination,
    data: contests,
  });

  const records = await mapWithConcurrency(contests, concurrency, async (contestSummary) => {
    const contestId = contestIdFromEntry(contestSummary);
    if (!contestId) {
      return {
        contestId: null,
        error: "invalid-contest-id",
      };
    }

    const detailFile = path.join(outputDir, "contests", `${contestId}.contest.json`);
    const awardsFile = path.join(outputDir, "awards", `${contestId}.awards.json`);
    const hasDetailCache = fs.existsSync(detailFile);
    const hasAwardsCache = fs.existsSync(awardsFile);

    if (hasDetailCache && hasAwardsCache) {
      try {
        const detailData = readJson(detailFile);
        const awardsData = asArray(readJson(awardsFile));
        return {
          contestId,
          summary: contestSummary,
          detail: detailData,
          links: asArray(contestSummary && contestSummary.links),
          awardCount: awardsData.length,
          detailFile: path.relative(outputDir, detailFile).replace(/\\/g, "/"),
          awardsFile: path.relative(outputDir, awardsFile).replace(/\\/g, "/"),
          fromCache: true,
        };
      } catch (error) {
        // Corrupted cache should not block crawl; fall through and refetch.
      }
    }

    try {
      const [detailPayload, awardsPayload] = await Promise.all([
        fetchJson(createApiUrl(baseUrl, `contest/${contestId}`)),
        fetchJson(createApiUrl(baseUrl, `contest/${contestId}/awards`)),
      ]);

      const detailData = detailPayload && detailPayload.data ? detailPayload.data : null;
      const awardsData = asArray(awardsPayload && awardsPayload.data);

      writeJson(detailFile, detailData);
      writeJson(awardsFile, awardsData);

      return {
        contestId,
        summary: contestSummary,
        detail: detailData,
        links: asArray(contestSummary && contestSummary.links),
        awardCount: awardsData.length,
        detailFile: path.relative(outputDir, detailFile).replace(/\\/g, "/"),
        awardsFile: path.relative(outputDir, awardsFile).replace(/\\/g, "/"),
        fromCache: false,
      };
    } catch (error) {
      return {
        contestId,
        summary: contestSummary,
        links: asArray(contestSummary && contestSummary.links),
        awardCount: 0,
        error: error && error.message ? error.message : String(error),
      };
    }
  });

  const withError = records.filter((record) => !!record.error);
  const withoutError = records.filter((record) => !record.error);
  const fromCacheCount = withoutError.filter((record) => !!record.fromCache).length;
  const fetchedCount = withoutError.filter((record) => !record.fromCache).length;

  const index = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    pageSize,
    concurrency,
    totalContests: contests.length,
    success: withoutError.length,
    failed: withError.length,
    fromCache: fromCacheCount,
    fetched: fetchedCount,
    records,
  };

  writeJson(path.join(outputDir, "index.json"), index);
  writeJson(path.join(outputDir, "crawl-summary.json"), {
    generatedAt: index.generatedAt,
    baseUrl: index.baseUrl,
    pageSize: index.pageSize,
    concurrency: index.concurrency,
    totalContests: index.totalContests,
    success: index.success,
    failed: index.failed,
    fromCache: index.fromCache,
    fetched: index.fetched,
    failures: withError.map((item) => ({
      contestId: item.contestId,
      error: item.error,
    })),
  });

  return index;
}

function loadCpcfinderIndex(outputDir) {
  const resolvedDir = path.resolve(outputDir || DEFAULT_OUTPUT_DIR);
  const indexFile = path.join(resolvedDir, "index.json");
  if (!fs.existsSync(indexFile)) {
    throw new Error(`CPCFinder index file does not exist: ${indexFile}`);
  }
  const index = readJson(indexFile);
  return {
    outputDir: resolvedDir,
    index,
  };
}

function extractCpcfinderLinks(record) {
  const links = asArray(record && record.links);
  return links
    .map((item) => `${item && item.url ? item.url : ""}`.trim())
    .filter(Boolean);
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_CONCURRENCY,
  DEFAULT_PAGE_SIZE,
  DEFAULT_OUTPUT_DIR,
  asArray,
  crawlCpcfinder,
  extractCpcfinderLinks,
  loadCpcfinderIndex,
  normalizeText,
  normalizeUrlForMatch,
  parsePositiveInteger,
  readJson,
  writeJson,
};
