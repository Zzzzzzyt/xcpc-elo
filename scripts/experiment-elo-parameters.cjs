/**
 * Sweeps Elo parameters and aggregates prediction statistics for post-2020
 * ICPC/CCPC contests.
 *
 * Ranks are predicted from the member ratings recorded in the Elo output rather
 * than read from the `statistics` block of elo-core.cjs, which only exists for
 * frontend display.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const staticRoot = path.join(rootDir, "out", "static-ranklists");
const teammateMap = path.join(rootDir, "out", "teammate-map.json");
const experimentDir = "out/elo-experiment";
if (!fs.existsSync(experimentDir)) fs.mkdirSync(experimentDir, { recursive: true });
const sourceMap = path.join(rootDir, "out", "source-map.json");
if (fs.existsSync(sourceMap)) fs.copyFileSync(sourceMap, path.join(experimentDir, "source-map.json"));
const updateFactors = [0.75];
const scales = [400];
const searchOffsets = [0.5];
const seedRankRadii = [50];
const adjustDeltaLimits = [0];
const aggregationMethods = ["log-power-mean", "mean"];
const predictionAggregationMethods = [null];

// Layout of the player history rows written by compute-teammate-elo.cjs.
const HISTORY_CONTEST_INDEX = 0;
const HISTORY_RANK = 1;
const HISTORY_DELTA = 2;
const HISTORY_RATING = 3;

// Statistic used to rank the sweep results.
const objective = { statistic: "spearman", kind: "macroMean" };

/**
 * Checks whether a contest takes part in the experiment population.
 *
 * Unrated contests are excluded because they store no rating, which leaves the
 * member ratings of their teams unrecoverable; so are contests whose identifier
 * or title mentions a keyword that marks them as not part of the main series.
 *
 * @param {object} contest Contest row of the Elo output.
 * @returns {boolean} True for main, rated ICPC/CCPC contests of 2023 and later.
 */
function isScoredContest(contest) {
  const year = contest.startAt ? new Date(contest.startAt).getFullYear() : 0;
  const haystack = `${contest.key || ""} ${contest.sourcePath || ""} ${contest.title || ""}`;
  return (
    !contest.unrated &&
    year >= 2023 &&
    /^(icpc|ccpc)\//i.test(contest.sourcePath) &&
    !/invitational|preliminary|hongkong/i.test(haystack)
  );
}

/**
 * Sums the base-10 power of every rating.
 *
 * @param {number[]} ratings Ratings to convert.
 * @returns {number} Summed rating power.
 */
function sumRatingPower(ratings, scale) {
  var total = 0;
  for (const rating of ratings) {
    total += Math.pow(10, rating / scale);
  }
  return total;
}

const TEAM_RATING_AGGREGATIONS = {
  "log-power-sum": (ratedRatings, unratedCount, config) =>
    ratedRatings.length === 0
      ? config.initialRating + Math.log10(unratedCount) * config.scale
      : Math.log10(sumRatingPower(ratedRatings, config.scale)) * config.scale,
  "log-power-mean": (ratedRatings, unratedCount, config) =>
    ratedRatings.length === 0
      ? config.initialRating
      : Math.log10(sumRatingPower(ratedRatings, config.scale) / ratedRatings.length) * config.scale,
  mean: (ratedRatings, unratedCount, config) =>
    ratedRatings.length === 0
      ? config.initialRating
      : ratedRatings.reduce((sum, rating) => sum + rating, 0) / ratedRatings.length,
  max: (ratedRatings, unratedCount, config) => (ratedRatings.length === 0 ? config.initialRating : Math.max(...ratedRatings)),
};

/**
 * Rebuilds the teams of every contest from the player histories.
 *
 * Members are grouped into teams by their shared rank, and a member's rating
 * before the contest is the stored rating minus the applied delta. A team is
 * rated once at least one of its members competed before the contest, which is
 * what the prediction uses instead of the posterior ranks of the contest.
 *
 * @param {object[]} players Player rows of the Elo output.
 * @returns {Map<number, object[]>} Teams keyed by contest index, in rank order.
 */
function collectContestTeams(players) {
  const teamsByRankByContest = new Map();
  for (const player of players) {
    const history = player.history || [];
    // History is chronological, so the first entry is the earliest contest of
    // the member, and a smaller index means the member was rated already.
    const firstContestIndex = history.length > 0 ? history[0][HISTORY_CONTEST_INDEX] : 0;
    for (const entry of history) {
      const contestIndex = entry[HISTORY_CONTEST_INDEX];
      let teamsByRank = teamsByRankByContest.get(contestIndex);
      if (!teamsByRank) {
        teamsByRank = new Map();
        teamsByRankByContest.set(contestIndex, teamsByRank);
      }

      const rank = entry[HISTORY_RANK];
      let team = teamsByRank.get(rank);
      if (!team) {
        team = { rank, ratedRatings: [], unratedCount: 0, rating: 0, rated: false };
        teamsByRank.set(rank, team);
      }
      if (firstContestIndex < contestIndex) {
        team.ratedRatings.push(entry[HISTORY_RATING] - entry[HISTORY_DELTA]);
      } else {
        team.unratedCount += 1;
      }
    }
  }

  const teamsByContest = new Map();
  for (const [contestIndex, teamsByRank] of teamsByRankByContest) {
    const teams = [...teamsByRank.values()].sort((left, right) => left.rank - right.rank);
    for (const team of teams) {
      team.rated = team.ratedRatings.length > 0;
    }
    teamsByContest.set(contestIndex, teams);
  }
  return teamsByContest;
}

/**
 * Computes the Spearman rank correlation between the predicted and the actual
 * order of the rated teams.
 *
 * Both sides are recalculated within the rated subset, so they form a
 * permutation of 1..n, mirroring elo-core.cjs.
 *
 * @param {object[]} teams Contest teams in rank order.
 * @returns {object|null} Correlation and team count, or null when undefined.
 */
function computeSpearman(teams) {
  const rated = teams.filter((team) => team.rated);
  if (rated.length < 2) {
    return null;
  }

  const byPrediction = [...rated].sort((left, right) => right.rating - left.rating);
  const predictedRankByTeam = new Map(byPrediction.map((team, index) => [team, index + 1]));

  let sum = 0;
  for (let index = 0; index < rated.length; index += 1) {
    const diff = predictedRankByTeam.get(rated[index]) - (index + 1);
    sum += diff * diff;
  }

  return {
    value: 1 - (6 * sum) / (rated.length * (rated.length * rated.length - 1)),
    teamCount: rated.length,
  };
}

/**
 * Computes the root-mean-square deviation between actual and predicted rank.
 *
 * Only the rated teams are measured, and their predicted ranks are positions
 * among every team of the contest, mirroring elo-core.cjs.
 *
 * @param {object[]} teams Contest teams in rank order.
 * @returns {object|null} Deviation and team count, or null when undefined.
 */
function computeRankStddev(teams) {
  if (teams.length === 0) {
    return null;
  }

  const byPrediction = [...teams].sort((left, right) => right.rating - left.rating);
  const predictedRankByTeam = new Map(byPrediction.map((team, index) => [team, index + 1]));

  let deviation = 0;
  let count = 0;
  for (const team of teams) {
    if (!team.rated) {
      continue;
    }
    const diff = team.rank - predictedRankByTeam.get(team);
    deviation += diff * diff;
    count += 1;
  }

  if (count === 0) {
    return null;
  }
  return { value: Math.sqrt(deviation / count), teamCount: count };
}

/**
 * Computes how much of the actual top slice of a contest the prediction found.
 *
 * @param {object[]} teams Contest teams in rank order.
 * @param {number} fraction Share of the teams that forms the top slice.
 * @returns {object|null} Recall and slice size, or null when undefined.
 */
function computeTopRecall(teams, fraction) {
  if (teams.length < 2) {
    return null;
  }

  const sliceSize = Math.max(1, Math.round(teams.length * fraction));
  const actual = new Set(teams.slice(0, sliceSize));
  const predicted = [...teams].sort((left, right) => right.rating - left.rating).slice(0, sliceSize);

  let hits = 0;
  for (const team of predicted) {
    if (actual.has(team)) {
      hits += 1;
    }
  }

  return { value: hits / actual.size, teamCount: sliceSize };
}

// Statistics plugged into every sweep run. `compute` receives the teams of one
// contest and returns `{ value, teamCount }`, or null when the statistic is not
// defined for that contest.
const statisticsMethods = [
  { name: "spearman", compute: computeSpearman },
  { name: "stddev", compute: computeRankStddev },
  { name: "top10Recall", compute: (teams) => computeTopRecall(teams, 0.1) },
  { name: "top30Recall", compute: (teams) => computeTopRecall(teams, 0.3) },
];

/**
 * Aggregates every statistic over the scored contests.
 *
 * @param {object} output Elo output document.
 * @returns {object} Contest count and per-statistic macro/weighted means.
 */
function aggregateStatistics(output, predictionAggregationMethod) {
  if (!predictionAggregationMethod) {
    predictionAggregationMethod = output.config.teamRatingAggregation;
  }
  const runConfig = output.config || {};
  const config = {
    scale: Number.isFinite(runConfig.eloScale) ? runConfig.eloScale : 400,
    initialRating: Number.isFinite(runConfig.initialRating) ? runConfig.initialRating : 1400,
  };
  const teamsByContest = collectContestTeams(output.players || []);
  const aggregationFunction = TEAM_RATING_AGGREGATIONS[predictionAggregationMethod];
  for (const teams of teamsByContest.values()) {
    for (const team of teams) {
      team.rating = aggregationFunction(team.ratedRatings, team.unratedCount, config);
    }
  }

  const contests = (output.contests || []).filter(isScoredContest);
  const summary = { contests: contests.length, statistics: {} };
  for (const method of statisticsMethods) {
    const samples = [];
    for (const contest of contests) {
      const sample = method.compute(teamsByContest.get(contest.index) || []);
      if (sample && Number.isFinite(sample.value)) {
        samples.push(sample);
      }
    }

    const weightSum = samples.reduce((sum, sample) => sum + sample.teamCount, 0);
    summary.statistics[method.name] = {
      sampleCount: samples.length,
      macroMean: samples.length > 0 ? samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length : null,
      weightedMean:
        weightSum > 0 ? samples.reduce((sum, sample) => sum + sample.value * sample.teamCount, 0) / weightSum : null,
    };
  }

  return summary;
}

/**
 * Reads the objective value of a sweep result.
 *
 * @param {object} result Sweep result.
 * @returns {number} Objective value, or -Infinity when undefined.
 */
function objectiveValue(result) {
  const statistic = result.statistics[objective.statistic];
  const value = statistic ? statistic[objective.kind] : null;
  return Number.isFinite(value) ? value : -Infinity;
}

const results = [];
for (const scale of scales) {
  for (const updateFactor of updateFactors) {
    for (const searchOffset of searchOffsets) {
      for (const seedRankRadius of seedRankRadii) {
        for (const adjustDeltaLimit of adjustDeltaLimits) {
          for (const aggregationMethod of aggregationMethods) {
            for (const predictionAggregationMethod of predictionAggregationMethods) {
              console.log(
                new Date().toISOString(),
                scale,
                updateFactor,
                searchOffset,
                seedRankRadius,
                adjustDeltaLimit,
                aggregationMethod,
                predictionAggregationMethod,
              );
              const outputFile = path.join(experimentDir, `tmp-elo.json`);
              const result = spawnSync(
                process.execPath,
                [path.join(rootDir, "scripts", "compute-teammate-elo.cjs"), staticRoot, teammateMap, outputFile],
                {
                  cwd: rootDir,
                  env: {
                    ...process.env,
                    XCPC_ELO_SCALE: `${scale}`,
                    XCPC_ELO_UPDATE_FACTOR: `${updateFactor}`,
                    XCPC_ELO_SEARCH_OFFSET: `${searchOffset}`,
                    XCPC_ELO_SEED_RANK_RADIUS: `${seedRankRadius}`,
                    XCPC_ELO_MIN_ADJUST_DELTA: `${-adjustDeltaLimit}`,
                    XCPC_ELO_MAX_ADJUST_DELTA: `${adjustDeltaLimit}`,
                    XCPC_ELO_TEAM_RATING_AGGREGATION: `${aggregationMethod}`,
                  },
                  encoding: "utf8",
                },
              );
              if (result.status !== 0) throw new Error(result.stderr || result.stdout || `experiment failed!`);
              results.push({
                scale,
                updateFactor,
                searchOffset,
                seedRankRadius,
                adjustDeltaLimit,
                aggregationMethod,
                predictionAggregationMethod,
                ...aggregateStatistics(JSON.parse(fs.readFileSync(outputFile, "utf8")), predictionAggregationMethod),
              });
            }
          }
        }
      }
    }
  }
}

/**
 * Formats one CSV cell.
 *
 * @param {*} value Cell value.
 * @returns {string} Escaped cell text.
 */
function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = `${value}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serializes sweep results as CSV.
 *
 * @param {object[]} rows Sweep results, already sorted by the objective.
 * @returns {string} CSV text with a header row.
 */
function toCsv(rows) {
  const configColumns = [
    "scale",
    "updateFactor",
    "searchOffset",
    "seedRankRadius",
    "adjustDeltaLimit",
    "aggregationMethod",
    "contests",
  ];
  const statisticColumns = statisticsMethods.flatMap((method) => [
    `${method.name}MacroMean`,
    `${method.name}WeightedMean`,
    `${method.name}Samples`,
  ]);

  const lines = [[...configColumns, ...statisticColumns].join(",")];
  for (const row of rows) {
    const values = configColumns.map((column) => row[column]);
    for (const method of statisticsMethods) {
      const statistic = row.statistics[method.name] || {};
      values.push(statistic.macroMean, statistic.weightedMean, statistic.sampleCount);
    }
    lines.push(values.map(csvCell).join(","));
  }
  return lines.join("\n");
}

results.sort((left, right) => objectiveValue(right) - objectiveValue(left));
const csv = toCsv(results);
const csvFile = path.join(experimentDir, "results.csv");
fs.writeFileSync(csvFile, `${csv}\n`, "utf8");
console.log(JSON.stringify(results, null, 2));
console.log(`\nSaved ${results.length} results sorted by ${objective.statistic}.${objective.kind} to ${csvFile}`);
