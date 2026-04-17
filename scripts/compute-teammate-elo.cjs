const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_INITIAL_RATING = 1500;
const MIN_RATING_FOR_SEARCH = -10000;
const MAX_RATING_FOR_SEARCH = 10000;
const SEARCH_STEPS = 32;

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

function resolveText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return value["zh-CN"] || value.en || value.fallback || Object.values(value).find((v) => typeof v === "string") || "";
}

function normalize(value) {
  return `${value || ""}`.trim().replace(/\s+/g, " ");
}

function pairKey(organization, teamMember) {
  return `${organization}\u0001${teamMember}`;
}

function pairHashId(organization, teamMember) {
  const orgNorm = normalize(organization).toLowerCase();
  const memberNorm = normalize(teamMember).toLowerCase();
  const raw = `${orgNorm}\u0001${memberNorm}`;
  const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  return `xcpc_${digest.slice(0, 16)}`;
}

function collectStaticRanklistFiles(rootDir) {
  const files = [];

  function walk(dir) {
    const children = fs.readdirSync(dir, { withFileTypes: true });
    for (const child of children) {
      const fullPath = path.join(dir, child.name);
      if (child.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (child.isFile() && child.name.endsWith(".static.srk.json")) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function buildTeammateIndex(teammateMap) {
  const entries = Array.isArray(teammateMap && teammateMap.entries) ? teammateMap.entries : [];
  const byId = new Map();
  const byPair = new Map();
  const byPairLower = new Map();

  for (const entry of entries) {
    const id = `${entry && entry.id ? entry.id : ""}`.trim();
    const organization = normalize(entry && entry.organization);
    const teamMember = normalize(entry && entry.teamMember);
    if (!id || !organization || !teamMember) {
      continue;
    }

    const key = pairKey(organization, teamMember);
    byId.set(id, { id, organization, teamMember, appearances: entry.appearances || 0 });
    byPair.set(key, id);
    byPairLower.set(key.toLowerCase(), id);
  }

  return { byId, byPair, byPairLower };
}

function resolveTeammateId(organization, teamMember, teammateIndex) {
  const org = normalize(organization);
  const member = normalize(teamMember);
  if (!org || !member) {
    return null;
  }

  const key = pairKey(org, member);
  const exact = teammateIndex.byPair.get(key);
  if (exact) {
    return exact;
  }

  const lower = teammateIndex.byPairLower.get(key.toLowerCase());
  if (lower) {
    return lower;
  }

  const hashId = pairHashId(org, member);
  if (teammateIndex.byId.has(hashId)) {
    return hashId;
  }

  return null;
}

function parseContestTimestamp(contest) {
  const startAt = contest && contest.startAt ? contest.startAt : null;
  const ts = startAt ? Date.parse(startAt) : Number.NaN;
  return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
}

function probabilityOpponentBeatsPlayer(playerRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (playerRating - opponentRating) / 400));
}

function seedForRating(rating, ratings) {
  let seed = 1;
  for (const otherRating of ratings) {
    seed += probabilityOpponentBeatsPlayer(rating, otherRating);
  }
  return seed;
}

function findRatingForSeed(targetSeed, ratings) {
  let low = MIN_RATING_FOR_SEARCH;
  let high = MAX_RATING_FOR_SEARCH;

  for (let i = 0; i < SEARCH_STEPS; i += 1) {
    const middle = (low + high) / 2;
    const middleSeed = seedForRating(middle, ratings);
    if (middleSeed > targetSeed) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return Math.trunc(low);
}

function applyCodeforcesUpdate(participants, getRating) {
  const rows = participants.map((participant) => ({
    id: participant.id,
    rank: participant.rank,
    rating: getRating(participant.id),
    seed: 1,
    delta: 0,
  }));

  if (rows.length < 2) {
    return rows;
  }

  for (let i = 0; i < rows.length; i += 1) {
    let seed = 1;
    for (let j = 0; j < rows.length; j += 1) {
      if (i === j) continue;
      seed += probabilityOpponentBeatsPlayer(rows[i].rating, rows[j].rating);
    }
    rows[i].seed = seed;
  }

  const ratings = rows.map((row) => row.rating);
  for (const row of rows) {
    const middleRank = Math.sqrt(row.rank * row.seed);
    const neededRating = findRatingForSeed(middleRank, ratings);
    row.delta = Math.trunc((neededRating - row.rating) / 2);
  }

  const sumDelta = rows.reduce((acc, row) => acc + row.delta, 0);
  const inc1 = Math.trunc((-sumDelta) / rows.length) - 1;
  for (const row of rows) {
    row.delta += inc1;
  }

  const topCount = Math.min(rows.length, Math.floor(4 * Math.sqrt(rows.length)) + 1);
  const byRating = [...rows].sort((a, b) => b.rating - a.rating || a.rank - b.rank || a.id.localeCompare(b.id));
  const sumTop = byRating.slice(0, topCount).reduce((acc, row) => acc + row.delta, 0);
  let inc2 = Math.trunc((-sumTop) / topCount);
  inc2 = Math.max(-10, Math.min(0, inc2));
  for (const row of rows) {
    row.delta += inc2;
  }

  return rows;
}

function ratingTitle(rating) {
  if (rating < 1200) return "newbie";
  if (rating < 1400) return "pupil";
  if (rating < 1600) return "specialist";
  if (rating < 1900) return "expert";
  if (rating < 2100) return "candidate master";
  if (rating < 2300) return "master";
  if (rating < 2400) return "international master";
  if (rating < 2600) return "grandmaster";
  if (rating < 3000) return "international grandmaster";
  return "legendary grandmaster";
}

function buildContestParticipants(ranklist, contestKey, teammateIndex, unmatchedByPair) {
  const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
  const rankById = new Map();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rank = index + 1;
    const user = row && row.user ? row.user : {};
    const organization = normalize(resolveText(user.organization));
    const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
    if (!organization || !teamMembers.length) {
      continue;
    }

    const rowIds = new Set();
    for (const member of teamMembers) {
      const teamMember = normalize(resolveText(member && member.name));
      if (!teamMember) {
        continue;
      }

      const id = resolveTeammateId(organization, teamMember, teammateIndex);
      if (!id) {
        const key = pairKey(organization, teamMember);
        if (!unmatchedByPair.has(key)) {
          unmatchedByPair.set(key, {
            organization,
            teamMember,
            count: 0,
            contests: new Set(),
          });
        }
        const item = unmatchedByPair.get(key);
        item.count += 1;
        item.contests.add(contestKey);
        continue;
      }

      rowIds.add(id);
    }

    for (const id of rowIds) {
      if (!rankById.has(id)) {
        rankById.set(id, rank);
      }
    }
  }

  return [...rankById.entries()]
    .map(([id, rank]) => ({ id, rank }))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

function buildTeammateElo(staticRootDir, teammateMapFile, outputFile, initialRating) {
  const teammateMap = readJson(teammateMapFile);
  const teammateIndex = buildTeammateIndex(teammateMap);
  const staticFiles = collectStaticRanklistFiles(staticRootDir);
  const unmatchedByPair = new Map();

  const contests = staticFiles.map((filePath) => {
    const ranklist = readJson(filePath);
    const contestKey = path.basename(filePath, ".static.srk.json");
    const contest = ranklist && ranklist.contest ? ranklist.contest : {};
    const title = resolveText(contest.title) || contestKey;
    const participants = buildContestParticipants(ranklist, contestKey, teammateIndex, unmatchedByPair);

    return {
      key: contestKey,
      file: path.relative(staticRootDir, filePath).replace(/\\/g, "/"),
      startAt: contest.startAt || null,
      title,
      timestamp: parseContestTimestamp(contest),
      participants,
    };
  });

  contests.sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key));
  contests.forEach((contest, index) => {
    contest.index = index;
  });

  const playerStates = new Map();
  for (const entry of teammateIndex.byId.values()) {
    playerStates.set(entry.id, {
      id: entry.id,
      organization: entry.organization,
      teamMember: entry.teamMember,
      mapAppearances: entry.appearances || 0,
      rating: initialRating,
      maxRating: initialRating,
      minRating: initialRating,
      contests: 0,
      history: [],
      lastDelta: 0,
    });
  }

  let totalRatingEvents = 0;
  for (const contest of contests) {
    const updates = applyCodeforcesUpdate(contest.participants, (id) => {
      if (!playerStates.has(id)) {
        playerStates.set(id, {
          id,
          organization: "",
          teamMember: "",
          mapAppearances: 0,
          rating: initialRating,
          maxRating: initialRating,
          minRating: initialRating,
          contests: 0,
          history: [],
          lastDelta: 0,
        });
      }
      return playerStates.get(id).rating;
    });

    for (const item of updates) {
      const state = playerStates.get(item.id);
      const newRating = state.rating + item.delta;
      state.rating = newRating;
      state.maxRating = Math.max(state.maxRating, newRating);
      state.minRating = Math.min(state.minRating, newRating);
      state.contests += 1;
      state.lastDelta = item.delta;
      state.history.push([contest.index, item.rank, item.delta, newRating]);
      totalRatingEvents += 1;
    }
  }

  const players = [...playerStates.values()]
    .map((state) => ({
      id: state.id,
      organization: state.organization,
      teamMember: state.teamMember,
      mapAppearances: state.mapAppearances,
      contests: state.contests,
      rating: state.rating,
      maxRating: state.maxRating,
      minRating: state.minRating,
      lastDelta: state.lastDelta,
      title: ratingTitle(state.rating),
      history: state.history,
    }))
    .sort((a, b) => b.rating - a.rating || b.maxRating - a.maxRating || b.contests - a.contests || a.id.localeCompare(b.id));

  for (let index = 0; index < players.length; index += 1) {
    players[index].rank = index + 1;
  }

  const unmatchedPairs = [...unmatchedByPair.values()]
    .map((item) => ({
      organization: item.organization,
      teamMember: item.teamMember,
      count: item.count,
      contests: [...item.contests].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.organization.localeCompare(b.organization) || a.teamMember.localeCompare(b.teamMember));

  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      staticRootDir,
      teammateMapFile,
      totalStaticRanklists: contests.length,
      totalMappedTeammates: teammateIndex.byId.size,
    },
    config: {
      algorithm: "Codeforces rating (seed / mid-rank / two-step correction)",
      rankRule: "team rank = row index in ranklist.rows (1-based)",
      initialRating,
    },
    totals: {
      contests: contests.length,
      players: players.length,
      ratingEvents: totalRatingEvents,
      unmatchedPairs: unmatchedPairs.length,
    },
    contests: contests.map((contest) => ({
      index: contest.index,
      key: contest.key,
      file: contest.file,
      title: contest.title,
      startAt: contest.startAt,
      participantCount: contest.participants.length,
    })),
    players,
    unmatchedPairs,
  };

  writeJson(outputFile, output);
  return output;
}

function main() {
  const staticRootDir = path.resolve(process.argv[2] || path.join("out", "static-ranklists"));
  const teammateMapFile = path.resolve(process.argv[3] || path.join("out", "teammate-map.json"));
  const outputFile = path.resolve(process.argv[4] || path.join("out", "teammate-elo.json"));
  const initialRatingArg = Number.parseInt(process.argv[5] || "", 10);
  const initialRating = Number.isFinite(initialRatingArg) ? initialRatingArg : DEFAULT_INITIAL_RATING;

  if (!fs.existsSync(staticRootDir)) {
    throw new Error(`Static ranklist directory does not exist: ${staticRootDir}`);
  }
  if (!fs.existsSync(teammateMapFile)) {
    throw new Error(`Teammate map does not exist: ${teammateMapFile}`);
  }

  const result = buildTeammateElo(staticRootDir, teammateMapFile, outputFile, initialRating);

  console.log(`Processed contests: ${result.totals.contests}`);
  console.log(`Computed players: ${result.totals.players}`);
  console.log(`Rating events: ${result.totals.ratingEvents}`);
  console.log(`Unmatched pairs: ${result.totals.unmatchedPairs}`);
  console.log(`Saved teammate Elo data to: ${outputFile}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}

