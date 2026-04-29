const fs = require("fs");
const path = require("path");
const { ArgumentParser } = require("argparse");
const { readJson } = require("./lib/ranklist-utils.cjs");
const {
	AGGREGATION_MODES,
	buildLookupKey,
	buildTeamEntriesFromRanklist,
	createRatingIndex,
	parseAggregationMode,
	predictEntries,
} = require("./lib/ranking-predictor.cjs");

function parseCliArgs(argv) {
	const parser = new ArgumentParser({
		prog: "node scripts/evaluate-ranking-prediction.cjs",
		description: "Backtest teammate Elo aggregation modes against historical contest rankings.",
	});

	parser.add_argument("--elo", {
		default: path.join("out", "teammate-elo.optimized.json"),
		help: "Elo JSON path. Defaults to out/teammate-elo.optimized.json.",
	});
	parser.add_argument("--static-root", {
		default: path.join("out", "static-ranklists"),
		help: "Static ranklist directory. Defaults to out/static-ranklists.",
	});
	parser.add_argument("--modes", {
		default: AGGREGATION_MODES.join(","),
		help: `Comma-separated aggregation modes. Supported: ${AGGREGATION_MODES.join(", ")}.`,
	});
	parser.add_argument("--output", {
		help: "Optional JSON output path for the aggregated evaluation results.",
	});

	const parsed = parser.parse_args(argv.slice(2));
	const modes = [...new Set(`${parsed.modes || ""}`
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => parseAggregationMode(part)))];

	if (!modes.length) {
		throw new Error("No aggregation modes selected.");
	}

	return {
		eloPath: path.resolve(parsed.elo),
		staticRoot: path.resolve(parsed.static_root),
		modes,
		outputPath: parsed.output ? path.resolve(parsed.output) : null,
	};
}

function buildContestRatingUpdates(eloData) {
	const updatesByContestIndex = new Map();
	const players = Array.isArray(eloData && eloData.players) ? eloData.players : [];

	for (const player of players) {
		const organization = `${player && player.organization ? player.organization : ""}`.trim();
		const teamMember = `${player && player.teamMember ? player.teamMember : ""}`.trim();
		const history = Array.isArray(player && player.history) ? player.history : [];
		if (!organization || !teamMember || !history.length) {
			continue;
		}
		const key = buildLookupKey(organization, teamMember);

		for (const event of history) {
			const contestIndex = Number(event && event[0]);
			const ratingAfterContest = Number(event && event[3]);
			if (!Number.isInteger(contestIndex) || !Number.isFinite(ratingAfterContest)) {
				continue;
			}
			if (!updatesByContestIndex.has(contestIndex)) {
				updatesByContestIndex.set(contestIndex, []);
			}
			updatesByContestIndex.get(contestIndex).push({
				key,
				rating: ratingAfterContest,
			});
		}
	}

	return updatesByContestIndex;
}

function countInversions(values) {
	const tree = new Int32Array(values.length + 1);
	let inversions = 0;

	function add(index, delta) {
		for (let cursor = index; cursor < tree.length; cursor += cursor & -cursor) {
			tree[cursor] += delta;
		}
	}

	function sum(index) {
		let total = 0;
		for (let cursor = index; cursor > 0; cursor -= cursor & -cursor) {
			total += tree[cursor];
		}
		return total;
	}

	for (let index = values.length - 1; index >= 0; index -= 1) {
		const value = values[index];
		inversions += sum(value - 1);
		add(value, 1);
	}

	return inversions;
}

function scorePrediction(predictedEntries) {
	const teams = predictedEntries.length;
	if (teams < 2) {
		return null;
	}

	let sumAbsoluteError = 0;
	let sumSquaredError = 0;
	let championHit = 0;
	const predictedRanksInActualOrder = new Array(teams);

	for (const item of predictedEntries) {
		const actualRank = Number.isInteger(item.actualRank) ? item.actualRank : item.sourceRowIndex + 1;
		const diff = item.predictedRank - actualRank;
		sumAbsoluteError += Math.abs(diff);
		sumSquaredError += diff * diff;
		predictedRanksInActualOrder[actualRank - 1] = item.predictedRank;
		if (item.actualRank === 1 && item.predictedRank === 1) {
			championHit = 1;
		}
	}

	const totalPairs = teams * (teams - 1) / 2;
	const inversions = countInversions(predictedRanksInActualOrder);
	const pairAccuracy = totalPairs ? (totalPairs - inversions) / totalPairs : 1;
	const kendallTau = totalPairs ? 1 - (2 * inversions) / totalPairs : 1;
	const spearman = 1 - (6 * sumSquaredError) / (teams * (teams * teams - 1));

	return {
		teams,
		sumAbsoluteError,
		sumSquaredError,
		totalPairs,
		inversions,
		pairAccuracy,
		kendallTau,
		spearman,
		championHit,
	};
}

function formatMetric(value, digits = 4) {
	return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function summarizeModeResults(result) {
	return {
		mode: result.mode,
		contests: result.contests,
		skippedContests: result.skippedContests,
		teams: result.teams,
		skippedRows: result.skippedRows,
		rankMae: result.teams ? result.sumAbsoluteError / result.teams : Number.NaN,
		rankRmse: result.teams ? Math.sqrt(result.sumSquaredError / result.teams) : Number.NaN,
		pairAccuracy: result.totalPairs ? (result.totalPairs - result.inversions) / result.totalPairs : Number.NaN,
		kendallTau: result.totalPairs ? 1 - (2 * result.inversions) / result.totalPairs : Number.NaN,
		meanSpearman: result.contests ? result.sumSpearman / result.contests : Number.NaN,
		championHitRate: result.contests ? result.championHits / result.contests : Number.NaN,
	};
}

function evaluateAggregationModes(eloData, staticRoot, modes) {
	const contests = Array.isArray(eloData && eloData.contests) ? eloData.contests : [];
	const initialRating = Number.isFinite(eloData && eloData.config && eloData.config.initialRating)
		? eloData.config.initialRating
		: 1500;
	const currentRatings = new Map();
	const updatesByContestIndex = buildContestRatingUpdates(eloData);
	const resultsByMode = new Map(modes.map((mode) => [mode, {
		mode,
		contests: 0,
		skippedContests: 0,
		teams: 0,
		skippedRows: 0,
		sumAbsoluteError: 0,
		sumSquaredError: 0,
		totalPairs: 0,
		inversions: 0,
		sumSpearman: 0,
		championHits: 0,
	}]));

	for (const contest of contests) {
		const contestFile = path.resolve(staticRoot, contest && contest.file ? contest.file : `${contest.key}.static.srk.json`);
		if (!fs.existsSync(contestFile)) {
			throw new Error(`Static ranklist not found: ${contestFile}`);
		}

		const ranklist = readJson(contestFile);
		const allRows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
		const entries = buildTeamEntriesFromRanklist(ranklist);
		const skippedRows = allRows.length - entries.length;
		const ratingIndex = createRatingIndex({
			initialRating,
			ratingsByPair: currentRatings,
		});

		if (entries.length < 2) {
			for (const mode of modes) {
				const result = resultsByMode.get(mode);
				result.skippedContests += 1;
				result.skippedRows += skippedRows;
			}
		} else {
			for (const mode of modes) {
				const predictedEntries = predictEntries(entries, ratingIndex, mode, {
					tieBreak: "team-key",
				});
				const score = scorePrediction(predictedEntries);
				const result = resultsByMode.get(mode);
				result.contests += 1;
				result.teams += score.teams;
				result.skippedRows += skippedRows;
				result.sumAbsoluteError += score.sumAbsoluteError;
				result.sumSquaredError += score.sumSquaredError;
				result.totalPairs += score.totalPairs;
				result.inversions += score.inversions;
				result.sumSpearman += score.spearman;
				result.championHits += score.championHit;
			}
		}

		const contestUpdates = updatesByContestIndex.get(Number(contest && contest.index)) || [];
		for (const update of contestUpdates) {
			currentRatings.set(update.key, update.rating);
		}
	}

	return {
		totalContests: contests.length,
		results: [...resultsByMode.values()].map((result) => summarizeModeResults(result)),
	};
}

function main() {
	const { eloPath, staticRoot, modes, outputPath } = parseCliArgs(process.argv);
	if (!fs.existsSync(eloPath)) {
		throw new Error(`Elo JSON not found: ${eloPath}`);
	}
	if (!fs.existsSync(staticRoot)) {
		throw new Error(`Static ranklist directory not found: ${staticRoot}`);
	}

	const eloData = readJson(eloPath);
	const evaluation = evaluateAggregationModes(eloData, staticRoot, modes);
	const results = evaluation.results
		.sort((left, right) => right.pairAccuracy - left.pairAccuracy || left.rankMae - right.rankMae || left.mode.localeCompare(right.mode));

	console.log(`Backtest source: ${eloPath}`);
	console.log(`Static ranklists: ${staticRoot}`);
	console.log(`Modes: ${modes.join(", ")}`);
	console.log("");
	for (const result of results) {
		console.log(
			`${result.mode.padEnd(14)} `
			+ `pair_acc=${formatMetric(result.pairAccuracy)} `
			+ `kendall_tau=${formatMetric(result.kendallTau)} `
			+ `spearman=${formatMetric(result.meanSpearman)} `
			+ `rank_mae=${formatMetric(result.rankMae, 2)} `
			+ `rank_rmse=${formatMetric(result.rankRmse, 2)} `
			+ `champion_hit=${formatMetric(result.championHitRate)} `
			+ `contests=${result.contests}/${evaluation.totalContests} `
			+ `skipped=${result.skippedContests} `
			+ `teams=${result.teams}`
		);
	}

	if (outputPath) {
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(outputPath, `${JSON.stringify({
			generatedAt: new Date().toISOString(),
			eloPath,
			staticRoot,
			modes,
			totalContests: evaluation.totalContests,
			results,
		}, null, 2)}\n`, "utf8");
		console.log("");
		console.log(`Saved evaluation summary to: ${outputPath}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error && error.message ? error.message : String(error));
	process.exit(1);
}
