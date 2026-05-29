const path = require("path");
const { convertToStaticRanklist } = require("@algoux/standard-ranklist-utils");
const {
  assessParticipantNames,
  parseCollectionConfig,
  normalizeRanklistTeamMembers,
  readJson,
  resolveText,
  shouldSkipContest,
  writeJson,
} = require("./lib/ranklist-utils.cjs");

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

async function computeAllStaticRanklists(collectionDir, outputDir) {
  const files = parseCollectionConfig(collectionDir);
  let generatedCount = 0;
  let excludedCount = 0;
  const failures = [];
  const excludedItems = [];
  const invalidNameItems = [];
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

      const contestTitle = resolveText(ranklist && ranklist.contest && ranklist.contest.title);
      const contestDateKey = resolveContestDateKey(ranklist);
      if (contestTitle && contestDateKey) {
        const duplicateKey = `${contestTitle}\u0001${contestDateKey}`;
        const firstSeen = seenTitleEntries.get(duplicateKey);
        if (firstSeen) {
          excludedCount += 1;
          excludedItems.push({
            uniqueKey: entry.uniqueKey,
            file: entry.relativeFilePath,
            reason: "duplicate-title",
            detail: `duplicate contest title/date: ${contestTitle} @ ${contestDateKey}`,
            duplicateOf: firstSeen.uniqueKey,
            duplicateOfFile: firstSeen.relativeFilePath,
          });
          continue;
        }

        seenTitleEntries.set(duplicateKey, {
          uniqueKey: entry.uniqueKey,
          relativeFilePath: entry.relativeFilePath,
        });
      }

      const staticRanklist = convertToStaticRanklist(ranklist);
      const invalidCheck = assessParticipantNames(staticRanklist);
      if (invalidCheck.invalid) {
        invalidNameItems.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          detail: invalidCheck.detail,
          invalidRows: invalidCheck.invalidRows,
        });
      }

      writeJson(outFilePath, staticRanklist);
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
