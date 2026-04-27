const path = require("path");
const crypto = require("crypto");
const {
  applyCodeforcesUpdate,
  parseContestTimestamp,
  ratingTitle,
  DEFAULT_INITIAL_RATING,
  ELO_SCALE,
} = require("./lib/elo-core.cjs");
const {
  assessParticipantNames,
  collectStaticRanklistFiles,
  normalize,
  readJson,
  resolveText,
  writeJson,
} = require("./lib/ranklist-utils.cjs");

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
    byId.set(id, {
      id,
      organization,
      teamMember,
      appearances: entry.appearances || 0,
      fromMap: true,
    });
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

  const id = pairHashId(org, member);
  if (!teammateIndex.byId.has(id)) {
    teammateIndex.byId.set(id, {
      id,
      organization: org,
      teamMember: member,
      appearances: 0,
      fromMap: false,
    });
  }
  teammateIndex.byPair.set(key, id);
  teammateIndex.byPairLower.set(key.toLowerCase(), id);
  return id;
}

function buildContestParticipants(ranklist, contestKey, teammateIndex, unresolvedEntries) {
  const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
  const rankById = new Map();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rank = index + 1;
    const user = row && row.user ? row.user : {};
    const organization = normalize(resolveText(user.organization));
    const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
    if (!organization || !teamMembers.length) {
      unresolvedEntries.push({
        contestKey,
        rank,
        reason: !organization ? "missing-organization" : "missing-team-members",
      });
      continue;
    }

    const rowIds = new Set();
    for (const member of teamMembers) {
      const teamMember = normalize(resolveText(member && member.name));
      if (!teamMember) {
        unresolvedEntries.push({
          contestKey,
          rank,
          reason: "empty-member-name",
        });
        continue;
      }

      const id = resolveTeammateId(organization, teamMember, teammateIndex);
      if (!id) {
        unresolvedEntries.push({
          contestKey,
          rank,
          reason: "unresolvable-member",
          organization,
          teamMember,
        });
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

  const unresolvedEntries = [];
  const skippedInvalidContests = [];
  const contests = [];

  for (const filePath of staticFiles) {
    const ranklist = readJson(filePath);
    const contestKey = path.basename(filePath, ".static.srk.json");
    const contest = ranklist && ranklist.contest ? ranklist.contest : {};
    const title = resolveText(contest.title) || contestKey;

    const nameCheck = assessParticipantNames(ranklist);
    if (nameCheck.invalid) {
      skippedInvalidContests.push({
        key: contestKey,
        file: path.relative(staticRootDir, filePath).replace(/\\/g, "/"),
        detail: nameCheck.detail,
      });
      continue;
    }

    const participants = buildContestParticipants(ranklist, contestKey, teammateIndex, unresolvedEntries);
    contests.push({
      key: contestKey,
      file: path.relative(staticRootDir, filePath).replace(/\\/g, "/"),
      title,
      startAt: contest.startAt || null,
      timestamp: parseContestTimestamp(contest),
      participants,
    });
  }

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
        const indexEntry = teammateIndex.byId.get(id) || {};
        playerStates.set(id, {
          id,
          organization: normalize(indexEntry.organization),
          teamMember: normalize(indexEntry.teamMember),
          mapAppearances: indexEntry.appearances || 0,
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

  const unresolvedCounts = new Map();
  for (const item of unresolvedEntries) {
    unresolvedCounts.set(item.reason, (unresolvedCounts.get(item.reason) || 0) + 1);
  }
  const unresolvedSummary = [...unresolvedCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      staticRootDir,
      teammateMapFile,
      totalStaticRanklists: staticFiles.length,
      usedContests: contests.length,
      skippedInvalidContests: skippedInvalidContests.length,
      totalMappedTeammates: teammateIndex.byId.size,
    },
    config: {
      algorithm: "Codeforces rating (seed / mid-rank / two-step correction)",
      rankRule: "team rank = row index in ranklist.rows (1-based)",
      initialRating,
      eloScale: ELO_SCALE,
    },
    totals: {
      contests: contests.length,
      players: players.length,
      ratingEvents: totalRatingEvents,
      unresolvedEntries: unresolvedEntries.length,
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
    skippedInvalidContests,
    unresolvedSummary,
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

  const result = buildTeammateElo(staticRootDir, teammateMapFile, outputFile, initialRating);
  console.log(`Used contests: ${result.totals.contests}`);
  console.log(`Computed players: ${result.totals.players}`);
  console.log(`Rating events: ${result.totals.ratingEvents}`);
  console.log(`Skipped invalid contests: ${result.source.skippedInvalidContests}`);
  console.log(`Saved teammate Elo data to: ${outputFile}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
