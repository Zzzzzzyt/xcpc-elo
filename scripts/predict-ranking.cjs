const fs = require("fs");
const path = require("path");
const { ArgumentParser } = require("argparse");
const { parse: parseCsvSync } = require("csv-parse/sync");
const { stringify: stringifyCsvSync } = require("csv-stringify/sync");
const { normalize, readJson } = require("./lib/ranklist-utils.cjs");

const TEAMMATE_HEADER_PATTERN = /teammate|队员/i;
const ORG_HEADER_PATTERN = /school|university|学校|院校/i;
const NAME_SPLIT_PATTERN = /[;,，、\/\|\n\t]+/;

function parseCsv(text) {
	const rows = parseCsvSync(text, {
		relax_column_count: true,
		skip_empty_lines: false,
	});

	if (!rows.length) {
		return { headers: [], rows: [] };
	}

	const headers = rows[0].map((h, index) => {
		const value = index === 0 ? `${h || ""}`.replace(/^\uFEFF/, "") : h;
		return normalize(value);
	});
	const dataRows = rows.slice(1).map((rawRow) => {
		const padded = rawRow.slice();
		while (padded.length < headers.length) {
			padded.push("");
		}
		return padded.slice(0, headers.length);
	});

	return { headers, rows: dataRows };
}

function stringifyCsv(headers, rows) {
	return stringifyCsvSync([headers, ...rows]);
}

function splitTeammates(rawText) {
	const text = normalize(rawText);
	if (!text) {
		return [];
	}

	return text
		.split(NAME_SPLIT_PATTERN)
		.map((part) => normalize(part))
		.filter(Boolean);
}

function buildRatingIndex(eloData, fallbackInitialRating) {
	const configuredInitialRating = Number.isFinite(eloData && eloData.config && eloData.config.initialRating)
		? eloData.config.initialRating
		: 1500;
	const initialRating = Number.isFinite(fallbackInitialRating)
		? fallbackInitialRating
		: configuredInitialRating;
	const players = Array.isArray(eloData && eloData.players) ? eloData.players : [];
	const ratingByPair = new Map();

	for (const player of players) {
		const org = normalize(player && player.organization).toLowerCase();
		const member = normalize(player && player.teamMember).toLowerCase();
		const rating = Number(player && player.rating);
		if (!org || !member || !Number.isFinite(rating)) {
			continue;
		}
		ratingByPair.set(`${org}\u0001${member}`, rating);
	}

	return {
		initialRating,
		getRating(organization, teammate) {
			const key = `${normalize(organization).toLowerCase()}\u0001${normalize(teammate).toLowerCase()}`;
			const rating = ratingByPair.get(key);
			if (Number.isFinite(rating)) {
				return { rating, known: true };
			}
			return { rating: initialRating, known: false };
		},
	};
}

function detectColumnIndexes(headers) {
	const teammateIndexes = [];
	let organizationIndex = -1;

	for (let i = 0; i < headers.length; i += 1) {
		const header = headers[i] || "";
		if (TEAMMATE_HEADER_PATTERN.test(header)) {
			teammateIndexes.push(i);
		}
		if (organizationIndex < 0 && ORG_HEADER_PATTERN.test(header)) {
			organizationIndex = i;
		}
	}

	return { teammateIndexes, organizationIndex };
}

function parseAggregationMode(modeArg) {
	const mode = normalize(modeArg || "sum").toLowerCase();
	if (mode === "sum" || mode === "max") {
		return mode;
	}
	throw new Error(`Invalid mode: ${modeArg}. Use \"sum\" or \"max\".`);
}

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
		choices: ["sum", "max"],
		default: "sum",
		help: "Aggregation mode: sum teammate ratings or use max teammate rating.",
	});
	parser.add_argument("--default-elo", {
		help: "Fallback Elo rating for unknown teammates. Defaults to Elo config initialRating (or 1500).",
	});
	parser.add_argument("--verbose", {
		action: "store_true",
		help: "Include detailed prediction columns: predicted_known_members, predicted_unknown_members, predicted_teammates.",
	});

	const parsed = parser.parse_args(argv.slice(2));
	const defaultEloValue = parsed.default_elo == null ? null : Number(parsed.default_elo);
	if (parsed.default_elo != null && !Number.isFinite(defaultEloValue)) {
		throw new Error(`Invalid --default-elo value: ${parsed.default_elo}`);
	}

	return {
		inputArg: parsed.input,
		outputArg: parsed.output || null,
		eloArg: parsed.elo || null,
		aggregationMode: parseAggregationMode(parsed.mode),
		defaultElo: defaultEloValue,
		verbose: Boolean(parsed.verbose),
	};
}

function predictRows(parsedCsv, ratingIndex, teammateIndexes, organizationIndex, aggregationMode) {
	const predicted = parsedCsv.rows.map((row, rowIndex) => {
		const organization = organizationIndex >= 0 ? normalize(row[organizationIndex]) : "";
		const teammateNames = [...new Set(teammateIndexes.flatMap((idx) => splitTeammates(row[idx])))]
			.map((name) => normalize(name))
			.filter(Boolean);

		const ratingValues = [];
		let knownMembers = 0;
		let unknownMembers = 0;

		for (const name of teammateNames) {
			const resolved = ratingIndex.getRating(organization, name);
			ratingValues.push(resolved.rating);
			if (resolved.known) {
				knownMembers += 1;
			} else {
				unknownMembers += 1;
			}
		}

		const ratingScore = aggregationMode === "max"
			? (ratingValues.length ? Math.max(...ratingValues) : 0)
			: ratingValues.reduce((sum, value) => sum + value, 0);

		return {
			originalRow: row,
			sourceRowIndex: rowIndex,
			organization,
			teammateNames,
			ratingScore,
			knownMembers,
			unknownMembers,
		};
	});

	predicted.sort((a, b) => b.ratingScore - a.ratingScore || b.knownMembers - a.knownMembers || a.sourceRowIndex - b.sourceRowIndex);
	for (let i = 0; i < predicted.length; i += 1) {
		predicted[i].predictedRank = i + 1;
	}
	return predicted;
}

function main() {
	const {
		inputArg,
		outputArg: outputArgFromCli,
		eloArg,
		aggregationMode,
		defaultElo,
		verbose,
	} = parseCliArgs(process.argv);
	if (!inputArg) {
		throw new Error("Usage: node scripts/predict-ranking.cjs <input.csv> [output.csv] [elo.json] [--mode sum|max] [--default-elo <number>] [--verbose]");
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

	const csvText = fs.readFileSync(inputCsvPath, "utf8");
	const parsedCsv = parseCsv(csvText);
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

	const ratingIndex = buildRatingIndex(readJson(eloJsonPath), defaultElo);
	const predictedRows = predictRows(parsedCsv, ratingIndex, teammateIndexes, organizationIndex, aggregationMode);
	const scoreHeader = aggregationMode === "max" ? "predicted_elo_max" : "predicted_elo_sum";

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

	fs.mkdirSync(path.dirname(outputCsvPath), { recursive: true });
	fs.writeFileSync(outputCsvPath, stringifyCsv(outputHeaders, outputRows), "utf8");

	const totalKnown = predictedRows.reduce((sum, item) => sum + item.knownMembers, 0);
	const totalUnknown = predictedRows.reduce((sum, item) => sum + item.unknownMembers, 0);

	console.log(`Input CSV: ${inputCsvPath}`);
	console.log(`Output CSV: ${outputCsvPath}`);
	console.log(`Elo source: ${eloJsonPath}`);
	console.log(`Aggregation mode: ${aggregationMode}`);
	console.log(`Detected teammate columns: ${teammateIndexes.map((idx) => parsedCsv.headers[idx]).join(", ")}`);
	console.log(`Detected organization column: ${parsedCsv.headers[organizationIndex]}`);
	console.log(`Predicted teams: ${predictedRows.length}`);
	console.log(`Matched teammates: ${totalKnown}`);
	console.log(`Fallback teammates (initial ${ratingIndex.initialRating}): ${totalUnknown}`);
}

try {
	main();
} catch (error) {
	console.error(error && error.message ? error.message : String(error));
	process.exit(1);
}
