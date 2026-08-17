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
const { getPinyinInitials } = require("./lib/pinyin-utils.cjs");

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
  const output = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rank = index + 1;
    const user = row && row.user ? row.user : {};
    const organization = normalize(resolveText(user.organization));
    const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
    const outputMembers = [];
    if (!organization || !teamMembers.length) {
      unresolvedEntries.push({
        contestKey,
        rank,
        reason: !organization ? "missing-organization" : "missing-team-members",
      });
      continue;
    }

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
      outputMembers.push(id);
    }
    output.push({ rank, members: outputMembers });
  }

  return output;
}

function buildTeammateElo(staticRootDir, teammateMapFile, outputFile, initialRating) {
  const teammateMap = readJson(teammateMapFile);
  const teammateIndex = buildTeammateIndex(teammateMap);
  const staticFiles = collectStaticRanklistFiles(staticRootDir);
  const sourceMapFile = path.join(staticRootDir, "_source-map.json");
  const sourceMap = require("fs").existsSync(sourceMapFile) ? readJson(sourceMapFile) : {};

  const unresolvedEntries = [];
  const skippedInvalidContests = [];
  const contests = [];

  for (const filePath of staticFiles) {
    const ranklist = readJson(filePath);
    const contestKey = path.basename(filePath, ".static.srk.json");
    const contest = ranklist && ranklist.contest ? ranklist.contest : {};
    const title = resolveText(contest.title) || contestKey;

    const participants = buildContestParticipants(ranklist, contestKey, teammateIndex, unresolvedEntries);
    if (participants.length > 0) {
      contests.push({
        key: contestKey,
        file: path.relative(staticRootDir, filePath).replace(/\\/g, "/"),
        sourcePath: sourceMap[path.basename(filePath)] || null,
        title,
        startAt: contest.startAt || null,
        timestamp: parseContestTimestamp(contest),
        participants,
      });
    } else {
      skippedInvalidContests.push({
        key: contestKey,
        file: path.relative(staticRootDir, filePath).replace(/\\/g, "/"),
        reason: "no-valid-participants",
      });
    }
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
    const firstTimeParticipantCount = contest.participants.reduce((count, participant) => {
      const state = playerStates.get(participant.id);
      return count + (state && state.contests === 0 ? 1 : 0);
    }, 0);
    const [updates, diagnostics] = applyCodeforcesUpdate(contest.participants, (id) => {
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
      state.history.push([contest.index, item.rank, item.delta, newRating, item.performanceRating, item.seed]);
      totalRatingEvents += 1;
    }

    contest.diagnostics = {
      firstTimeParticipants: firstTimeParticipantCount,
      ...diagnostics,
    };
  }

  const players = [...playerStates.values()]
    .map((state) => ({
      id: state.id,
      organization: state.organization,
      teamMember: state.teamMember,
      pinyinInitials: getPinyinInitials(state.teamMember),
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
      sourcePath: contest.sourcePath,
      title: contest.title,
      startAt: contest.startAt,
      participantCount: contest.participants.length,
      diagnostics: contest.diagnostics || null,
    })),
    players,
    skippedInvalidContests,
    unresolvedSummary,
  };

  writeJson(outputFile, output, true);
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

main();
