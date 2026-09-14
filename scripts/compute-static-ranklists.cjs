/**
 * Converts SRK source contests into static ranklists for Elo processing.
 */
const path = require("path");
const { convertToStaticRanklist } = require("@algoux/standard-ranklist-utils");
const {
  assessParticipantNames,
  parseCollectionConfig,
  normalizeRanklistTeamMembers,
  normalize,
  readJson,
  resolveText,
  shouldSkipContest,
  teammatePairKey,
  writeJson,
} = require("./lib/ranklist-utils.cjs");
const crypto = require("crypto");

/**
 * Extracts the contest date from an ISO start timestamp.
 *
 * @param {object} ranklist Ranklist with contest metadata.
 * @returns {string} `YYYY-MM-DD`, or an empty string when unavailable.
 */
function resolveContestDateKey(ranklist) {
  const startAt = ranklist && ranklist.contest ? ranklist.contest.startAt : null;
  if (typeof startAt !== "string") {
    return "";
  }

  const trimmed = startAt.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.slice(0, 10);
}

/**
 * Builds a contest fingerprint from participant names.
 *
 * @param {object} ranklist Ranklist data.
 * @returns {string} MD5 digest of participant names.
 */
function resolveContestUserHash(ranklist) {
  const rows = ranklist.rows;
  const hash = crypto.createHash("md5");
  for (const row of rows) {
    const name = resolveText(row.user.name);
    hash.update(name || "");
  }
  return hash.digest("hex");
}

/**
 * Removes teams without submissions and repeated teammate-organization pairs
 * from a static ranklist, in one pass over the supplied ranks.
 *
 * A teammate pair is kept only in the highest ranked team listing it, that is
 * the first submitted row; later occurrences are dropped from their teams.
 * Teams that lose every member stay as empty teams so that the remaining rows
 * keep their positions. Ranks in the returned items are the original ranks of
 * the ranklist, since rank values depend on contest-specific rules and cannot
 * be recalculated after filtering.
 *
 * @param {object} staticRanklist Static ranklist to clean in place.
 * @returns {{ranklist: object, removedRows: object[], removedTeammates: object[]}} Cleaned ranklist and removals.
 */
function removeInvalidTeamsAndTeammates(staticRanklist) {
  const rows = Array.isArray(staticRanklist && staticRanklist.rows) ? staticRanklist.rows : [];
  const hasSubmission = (row) => Array.isArray(row && row.statuses) && row.statuses.some((problem) => problem.result !== null);
  // Without any submission data no team is filtered, so every row takes part in
  // the teammate cleanup; the ranklist itself is preserved further down.
  const keepAllRows = !rows.some(hasSubmission) || rows.every(hasSubmission);

  const removedRows = [];
  const removedTeammates = [];
  const keptRows = [];
  const keptByPair = new Map();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rank = rowIndex + 1;
    const row = rows[rowIndex];
    const rowHasSubmission = hasSubmission(row);
    if (rowHasSubmission) {
      keptRows.push(row);
    } else {
      removedRows.push({ rowIndex, rank, row });
    }

    // A dropped team cannot keep a teammate of its own.
    if (!rowHasSubmission && !keepAllRows) {
      continue;
    }

    const user = row && row.user ? row.user : {};
    const organization = normalize(resolveText(user.organization));
    const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
    if (!organization || teamMembers.length === 0) {
      continue;
    }

    const keptMembers = [];
    for (const member of teamMembers) {
      const name = normalize(resolveText(member && member.name));
      const pairKey = teammatePairKey(organization, name);
      const kept = keptByPair.get(pairKey);
      if (kept === undefined) {
        keptByPair.set(pairKey, { rank, team: normalize(resolveText(user.name)) });
        keptMembers.push(member);
        continue;
      }

      removedTeammates.push({
        rowIndex,
        rank,
        organization,
        team: normalize(resolveText(user.name)),
        name,
        keptRowIndex: kept.rank - 1,
        keptRank: kept.rank,
        keptTeam: kept.team,
      });
    }

    user.teamMembers = keptMembers;
    row.user = user;
  }

  // An entirely empty submission set usually indicates incomplete source data;
  // preserve the original ranklist instead of deleting every team. Rows are
  // kept as well when nothing had to be filtered.
  if (!keptRows.length || !removedRows.length) {
    return { ranklist: staticRanklist, removedRows, removedTeammates };
  }

  staticRanklist.rows = keptRows;
  return { ranklist: staticRanklist, removedRows, removedTeammates };
}

/**
 * Generates all static ranklists and writes processing summaries.
 *
 * @param {string} collectionDir SRK collection config directory.
 * @param {string} outputDir Directory for generated outputs.
 * @returns {Promise<object>} Processing summary.
 */
async function computeAllStaticRanklists(collectionDir, outputDir) {
  const files = parseCollectionConfig(collectionDir);
  let generatedCount = 0;
  let excludedCount = 0;
  const failures = [];
  const excludedItems = [];
  const invalidNameItems = [];
  const duplicateTeammateItems = [];
  const generatedSourcePaths = {};
  const seenTitleEntries = new Map();

  for (const entry of files) {
    const srcFilePath = path.join(collectionDir, entry.relativeFilePath);
    const outFilePath = path.join(outputDir, `static-ranklists/${entry.uniqueKey}.json`);

    try {
      const ranklist = normalizeRanklistTeamMembers(readJson(srcFilePath));
      const skipResult = shouldSkipContest(entry, ranklist);
      if (skipResult.skip) {
        excludedCount += 1;
        excludedItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          reason: skipResult.reason,
          detail: skipResult.detail,
        });
        continue;
      }

      const contestTitleRaw = resolveText(ranklist.contest.title);
      const contestTitle = contestTitleRaw.substring(0, Math.min(contestTitleRaw.length, 40)).trim();
      const contestUserHash = resolveContestUserHash(ranklist);
      const contestDateKey = resolveContestDateKey(ranklist);
      const duplicateKey = `${contestTitle}\u0001${contestDateKey}`;
      const duplicateKey2 = `${contestUserHash}\u0001${contestDateKey}`;

      const firstSeen = seenTitleEntries.get(duplicateKey);
      if (firstSeen) {
        excludedCount += 1;
        excludedItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          reason: "duplicate-title",
          detail: `duplicate contest title/date: ${contestTitleRaw} @ ${contestDateKey}`,
          duplicateOf: firstSeen.uniqueKey,
          duplicateOfFile: firstSeen.relativeFilePath,
        });
        continue;
      }

      const firstSeen2 = seenTitleEntries.get(duplicateKey2);
      if (firstSeen2) {
        excludedCount += 1;
        excludedItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          reason: "duplicate-user-hash",
          detail: `duplicate contest hash/date: ${contestUserHash} @ ${contestDateKey}`,
          duplicateOf: firstSeen2.uniqueKey,
          duplicateOfFile: firstSeen2.relativeFilePath,
        });
        continue;
      }

      seenTitleEntries.set(duplicateKey, {
        uniqueKey: entry.uniqueKey,
        relativeFilePath: entry.relativeFilePath,
      });
      seenTitleEntries.set(duplicateKey2, {
        uniqueKey: entry.uniqueKey,
        relativeFilePath: entry.relativeFilePath,
      });

      const staticRanklist = convertToStaticRanklist(ranklist);
      // Preserve the collection's curated short name alongside the original
      // SRK contest title. This intentionally extends the generated static
      // format for dashboard consumption.
      if (entry.alias) {
        staticRanklist.contest = staticRanklist.contest || {};
        staticRanklist.contest.alias = entry.alias;
      }
      const cleanupResult = removeInvalidTeamsAndTeammates(staticRanklist);
      if (cleanupResult.removedRows.length > 0) {
        invalidNameItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          reason: "no-submission",
          detail: `removed ${cleanupResult.removedRows.length} team(s) without submissions`,
          invalidRows: cleanupResult.removedRows.map((item) => ({
            rowIndex: item.rowIndex,
            rank: item.rank,
            organization: normalize(resolveText(item.row && item.row.user && item.row.user.organization)),
            team: normalize(resolveText(item.row && item.row.user && item.row.user.name)),
            reason: "no-submission",
          })),
        });
      }
      for (const item of cleanupResult.removedTeammates) {
        duplicateTeammateItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          ...item,
        });
      }

      const filteredRanklist = cleanupResult.ranklist;
      const invalidCheck = assessParticipantNames(filteredRanklist);
      if (invalidCheck.invalidRows.length > 0) {
        invalidNameItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          detail: invalidCheck.detail,
          invalidRows: invalidCheck.invalidRows,
        });
      }

      if (filteredRanklist.contributers !== undefined) delete filteredRanklist.contributers;
      if (filteredRanklist.series !== undefined) delete filteredRanklist.series;
      if (filteredRanklist.sorter !== undefined) delete filteredRanklist.sorter;
      if (filteredRanklist.markers !== undefined) delete filteredRanklist.markers;
      if (filteredRanklist.problems !== undefined) delete filteredRanklist.problems;

      filteredRanklist.rows.forEach((row) => {
        if (row.score !== undefined) delete row.score;
        if (row.statuses !== undefined) delete row.statuses;
        if (row.rankValues !== undefined) delete row.rankValues;
      });

      writeJson(outFilePath, filteredRanklist);
      generatedSourcePaths[path.basename(outFilePath)] = entry.relativeFilePath.replace(/\\/g, "/");
      generatedCount += 1;
    } catch (error) {
      failures.push({
        uniqueKey: entry.uniqueKey,
        file: entry.relativeFilePath,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    collectionDir,
    outputDir,
    total: files.length,
    generated: generatedCount,
    excluded: excludedCount,
    generatedWithInvalidTeammates: invalidNameItems.length,
    removedDuplicateTeammates: duplicateTeammateItems.length,
    failed: failures.length,
    excludedItems,
    invalidTeammateItems: invalidNameItems.map((item) => ({
      uniqueKey: item.uniqueKey,
      file: item.file,
      detail: item.detail,
    })),
    duplicateTeammateItems: duplicateTeammateItems.map((item) => ({
      uniqueKey: item.uniqueKey,
      file: item.file,
      rank: item.rank,
      keptRank: item.keptRank,
      organization: item.organization,
      team: item.team,
      name: item.name,
    })),
    failures,
  };

  writeJson(path.join(outputDir, "_static-ranklists-summary.json"), summary);
  writeJson(path.join(outputDir, "source-map.json"), generatedSourcePaths);
  writeJson(path.join(outputDir, "_invalid-teammates.json"), invalidNameItems);
  writeJson(path.join(outputDir, "_duplicate-teammates.json"), duplicateTeammateItems);
  return summary;
}

/**
 * CLI entry point for static ranklist generation.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const collectionDir = path.resolve(process.argv[2] || path.join("data", "srk-collection", "official"));
  const outputDir = path.resolve(process.argv[3] || "out");

  console.log(`Using collection: ${collectionDir}`);
  console.log(`Writing outputs to: ${outputDir}`);

  const summary = await computeAllStaticRanklists(collectionDir, outputDir);
  console.log(`Total contests: ${summary.total}`);
  console.log(`Generated static ranklists: ${summary.generated}`);
  console.log(`Excluded contests: ${summary.excluded}`);
  console.log(`Generated with invalid teammate names: ${summary.generatedWithInvalidTeammates}`);
  console.log(`Failed: ${summary.failed}`);

  if (summary.failed > 0) {
    console.log(`See ${path.join(outputDir, "_static-ranklists-summary.json")} for details.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
