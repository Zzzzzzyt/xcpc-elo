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
  writeJson,
} = require("./lib/ranklist-utils.cjs");
const crypto = require("crypto");

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

function resolveContestUserHash(ranklist) {
  const rows = ranklist.rows;
  const hash = crypto.createHash("md5");
  for (const row of rows) {
    const name = resolveText(row.user.name);
    hash.update(name || "");
  }
  return hash.digest("hex");
}

function removeTeamsWithoutSubmissions(staticRanklist) {
  const rows = Array.isArray(staticRanklist && staticRanklist.rows) ? staticRanklist.rows : [];
  const removedRows = [];
  const keptRows = [];
  const removedRowIndexes = new Set();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const hasSubmission = Array.isArray(row && row.statuses) && row.statuses.some((problem) => problem.result !== null);
    if (hasSubmission) {
      keptRows.push({ row, rowIndex });
    } else {
      removedRows.push({ rowIndex, rank: rowIndex + 1, row });
      removedRowIndexes.add(rowIndex);
    }
  }

  // An entirely empty submission set usually indicates incomplete source data;
  // preserve the original ranklist instead of deleting every team.
  if (!removedRows.length || !keptRows.length) {
    return { ranklist: staticRanklist, removedRows };
  }

  const removedBeforeByRowIndex = new Map();
  let removedBefore = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    removedBeforeByRowIndex.set(rowIndex, removedBefore);
    if (removedRowIndexes.has(rowIndex)) {
      removedBefore += 1;
    }
  }

  for (const item of keptRows) {
    const offset = removedBeforeByRowIndex.get(item.rowIndex) || 0;
    if (Array.isArray(item.row.rankValues)) {
      item.row.rankValues = item.row.rankValues.map((rankValue) => {
        if (!rankValue || !Number.isFinite(rankValue.rank)) {
          return rankValue;
        }
        return { ...rankValue, rank: rankValue.rank - offset };
      });
    }
  }

  staticRanklist.rows = keptRows.map((item) => item.row);
  return { ranklist: staticRanklist, removedRows };
}

async function computeAllStaticRanklists(collectionDir, outputDir) {
  const files = parseCollectionConfig(collectionDir);
  let generatedCount = 0;
  let excludedCount = 0;
  const failures = [];
  const excludedItems = [];
  const invalidNameItems = [];
  const generatedSourcePaths = {};
  const seenTitleEntries = new Map();

  for (const entry of files) {
    const srcFilePath = path.join(collectionDir, entry.relativeFilePath);
    const outFilePath = path.join(outputDir, `${entry.uniqueKey}.static.srk.json`);

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
      const noSubmissionResult = removeTeamsWithoutSubmissions(staticRanklist);
      if (noSubmissionResult.removedRows.length > 0) {
        invalidNameItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          reason: "no-submission",
          detail: `removed ${noSubmissionResult.removedRows.length} team(s) without submissions`,
          invalidRows: noSubmissionResult.removedRows.map((item) => ({
            rowIndex: item.rowIndex,
            rank: item.rank,
            organization: normalize(resolveText(item.row && item.row.user && item.row.user.organization)),
            team: normalize(resolveText(item.row && item.row.user && item.row.user.name)),
            reason: "no-submission",
          })),
        });
      }
      const filteredRanklist = noSubmissionResult.ranklist;
      const invalidCheck = assessParticipantNames(filteredRanklist);
      if (invalidCheck.invalidRows.length > 0) {
        invalidNameItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          detail: invalidCheck.detail,
          invalidRows: invalidCheck.invalidRows,
        });
      }

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
    failed: failures.length,
    excludedItems,
    invalidTeammateItems: invalidNameItems.map((item) => ({
      uniqueKey: item.uniqueKey,
      file: item.file,
      detail: item.detail,
    })),
    failures,
  };

  writeJson(path.join(outputDir, "_summary.json"), summary);
  writeJson(path.join(outputDir, "_source-map.json"), generatedSourcePaths);
  writeJson(path.join(outputDir, "_invalid-teammates.json"), invalidNameItems);
  return summary;
}

async function main() {
  const collectionDir = path.resolve(process.argv[2] || path.join("data", "srk-collection", "official"));
  const outputDir = path.resolve(process.argv[3] || path.join("out", "static-ranklists"));

  console.log(`Using collection: ${collectionDir}`);
  console.log(`Writing outputs to: ${outputDir}`);

  const summary = await computeAllStaticRanklists(collectionDir, outputDir);
  console.log(`Total contests: ${summary.total}`);
  console.log(`Generated static ranklists: ${summary.generated}`);
  console.log(`Excluded contests: ${summary.excluded}`);
  console.log(`Generated with invalid teammate names: ${summary.generatedWithInvalidTeammates}`);
  console.log(`Failed: ${summary.failed}`);

  if (summary.failed > 0) {
    console.log(`See ${path.join(outputDir, "_summary.json")} for details.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
