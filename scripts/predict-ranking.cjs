const fs = require("fs");
const path = require("path");
const { ArgumentParser } = require("argparse");
const { readJson } = require("./lib/ranklist-utils.cjs");
const {
	AGGREGATION_MODES,
	buildRatingIndex,
	buildTeamEntriesFromCsv,
	detectColumnIndexes,
	parseAggregationMode,
	parseCsv,
	predictEntries,
	scoreHeaderForMode,
	stringifyCsv,
} = require("./lib/ranking-predictor.cjs");
const {
	describeEncoding,
	readTextFileWithDetectedEncoding,
	writeTextFileWithEncoding,
} = require("./lib/text-encoding.cjs");

function parseCliArgs(argv) {
	const parser = new ArgumentParser({
		prog: "node scripts/predict-ranking.cjs",
		description: "Predict team ranking from teammate Elo ratings.",
	});

	parser.add_argument("input", {
		help: "Input CSV path.",
	});
	parser.add_argument("output", {
		nargs: "?",
		help: "Output CSV path.",
	});
	parser.add_argument("elo", {
		nargs: "?",
		help: "Elo JSON path.",
	});
	parser.add_argument("--mode", {
		default: "max",
		help: `Aggregation mode: ${AGGREGATION_MODES.join(", ")}.`,
	});
	parser.add_argument("--verbose", {
		action: "store_true",
		help: "Include detailed prediction columns: predicted_known_members, predicted_unknown_members, predicted_teammates.",
	});

	const parsed = parser.parse_args(argv.slice(2));

	return {
		inputArg: parsed.input,
		outputArg: parsed.output || null,
		eloArg: parsed.elo || null,
		aggregationMode: parseAggregationMode(parsed.mode),
		verbose: Boolean(parsed.verbose),
	};
}

function main() {
	const {
		inputArg,
		outputArg: outputArgFromCli,
		eloArg,
		aggregationMode,
		verbose,
	} = parseCliArgs(process.argv);
	if (!inputArg) {
		throw new Error(`Usage: node scripts/predict-ranking.cjs <input.csv> [output.csv] [elo.json] [--mode ${AGGREGATION_MODES.join("|")}] [--verbose]`);
	}
	const inputCsvPath = path.resolve(inputArg);

	const outputArg = outputArgFromCli
		|| (inputCsvPath.toLowerCase().endsWith(".csv") ? inputCsvPath.replace(/\.csv$/i, ".predicted.csv") : `${inputCsvPath}.predicted.csv`);
	const outputCsvPath = path.resolve(outputArg);
	const eloJsonPath = path.resolve(eloArg || path.join("out", "teammate-elo.optimized.json"));

	if (!fs.existsSync(inputCsvPath)) {
		throw new Error(`Input CSV not found: ${inputCsvPath}`);
	}
	if (!fs.existsSync(eloJsonPath)) {
		throw new Error(`Elo JSON not found: ${eloJsonPath}`);
	}

	const inputCsv = readTextFileWithDetectedEncoding(inputCsvPath);
	const parsedCsv = parseCsv(inputCsv.text);
	if (!parsedCsv.headers.length) {
		throw new Error("Input CSV has no rows.");
	}

	const { teammateIndexes, organizationIndex } = detectColumnIndexes(parsedCsv.headers);
	if (!teammateIndexes.length) {
		throw new Error("No teammate columns found. Header must contain /teammate/i or /队员/i.");
	}
	if (organizationIndex < 0) {
		throw new Error("No organization column found. Header must contain /school|university|学校|院校/i.");
	}

	const ratingIndex = buildRatingIndex(readJson(eloJsonPath));
	const teamEntries = buildTeamEntriesFromCsv(parsedCsv, teammateIndexes, organizationIndex);
	const predictedRows = predictEntries(teamEntries, ratingIndex, aggregationMode, {
		tieBreak: "source-order",
	});
	const scoreHeader = scoreHeaderForMode(aggregationMode);

	const outputHeaders = [
		"predicted_rank",
		scoreHeader,
		...parsedCsv.headers,
	];
	if (verbose) {
		outputHeaders.splice(2, 0, "predicted_known_members", "predicted_unknown_members", "predicted_teammates");
	}

	const outputRows = predictedRows.map((item) => {
		const row = [
			item.predictedRank,
			Math.round(item.ratingScore),
		];
		if (verbose) {
			row.push(item.knownMembers, item.unknownMembers, item.teammateNames.join("; "));
		}
		row.push(...item.originalRow);
		return row;
	});

	writeTextFileWithEncoding(outputCsvPath, stringifyCsv(outputHeaders, outputRows), inputCsv.encodingInfo);

	const totalKnown = predictedRows.reduce((sum, item) => sum + item.knownMembers, 0);
	const totalUnknown = predictedRows.reduce((sum, item) => sum + item.unknownMembers, 0);

	console.log(`Input CSV: ${inputCsvPath}`);
	console.log(`Output CSV: ${outputCsvPath}`);
	console.log(`Elo source: ${eloJsonPath}`);
	console.log(`CSV encoding: ${describeEncoding(inputCsv.encodingInfo)}`);
	console.log(`Aggregation mode: ${aggregationMode}`);
	console.log(`Detected teammate columns: ${teammateIndexes.map((idx) => parsedCsv.headers[idx]).join(", ")}`);
	console.log(`Detected organization column: ${parsedCsv.headers[organizationIndex]}`);
	console.log(`Predicted teams: ${predictedRows.length}`);
	console.log(`Matched teammates: ${totalKnown}`);
	console.log(`Ignored unmatched teammates: ${totalUnknown}`);
}

try {
	main();
} catch (error) {
	console.error(error && error.message ? error.message : String(error));
	process.exit(1);
}
