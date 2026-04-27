const fs = require("fs");
const path = require("path");
const { normalize, readJson } = require("./lib/ranklist-utils.cjs");

const TEAMMATE_HEADER_PATTERN = /teammate|队员/i;
const ORG_HEADER_PATTERN = /school|university|学校|院校/i;
const NAME_SPLIT_PATTERN = /[;,，、\/\|\n\t]+/;

function parseCsv(text) {
	const rows = [];
	let row = [];
	let cell = "";
	let i = 0;
	let inQuotes = false;

	while (i < text.length) {
		const ch = text[i];

		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i += 1;
				continue;
			}
			cell += ch;
			i += 1;
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
			i += 1;
			continue;
		}

		if (ch === ",") {
			row.push(cell);
			cell = "";
			i += 1;
			continue;
		}

		if (ch === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			i += 1;
			continue;
		}

		if (ch === "\r") {
			i += 1;
			continue;
		}

		cell += ch;
		i += 1;
	}

	if (cell.length > 0 || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}

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

function encodeCsvCell(value) {
	const text = `${value == null ? "" : value}`;
	if (!/[",\n\r]/.test(text)) {
		return text;
	}
	return `"${text.replace(/"/g, '""')}"`;
}

function stringifyCsv(headers, rows) {
	const lines = [];
	lines.push(headers.map(encodeCsvCell).join(","));
	for (const row of rows) {
		lines.push(row.map(encodeCsvCell).join(","));
	}
	return `${lines.join("\n")}\n`;
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

function buildRatingIndex(eloData) {
	const initialRating = Number.isFinite(eloData && eloData.config && eloData.config.initialRating)
		? eloData.config.initialRating
		: 1500;
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

function predictRows(parsedCsv, ratingIndex, teammateIndexes, organizationIndex) {
	const predicted = parsedCsv.rows.map((row, rowIndex) => {
		const organization = organizationIndex >= 0 ? normalize(row[organizationIndex]) : "";
		const teammateNames = [...new Set(teammateIndexes.flatMap((idx) => splitTeammates(row[idx])))]
			.map((name) => normalize(name))
			.filter(Boolean);

		let eloSum = 0;
		let knownMembers = 0;
		let unknownMembers = 0;

		for (const name of teammateNames) {
			const resolved = ratingIndex.getRating(organization, name);
			eloSum += resolved.rating;
			if (resolved.known) {
				knownMembers += 1;
			} else {
				unknownMembers += 1;
			}
		}

		return {
			originalRow: row,
			sourceRowIndex: rowIndex,
			organization,
			teammateNames,
			eloSum,
			knownMembers,
			unknownMembers,
		};
	});

	predicted.sort((a, b) => b.eloSum - a.eloSum || b.knownMembers - a.knownMembers || a.sourceRowIndex - b.sourceRowIndex);
	for (let i = 0; i < predicted.length; i += 1) {
		predicted[i].predictedRank = i + 1;
	}
	return predicted;
}

function main() {
	const inputArg = process.argv[2];
	if (!inputArg) {
		throw new Error("Usage: node scripts/predict-ranking.cjs <input.csv> [output.csv] [elo.json]");
	}
	const inputCsvPath = path.resolve(inputArg);

	const outputArg = process.argv[3]
		|| (inputCsvPath.toLowerCase().endsWith(".csv") ? inputCsvPath.replace(/\.csv$/i, ".predicted.csv") : `${inputCsvPath}.predicted.csv`);
	const outputCsvPath = path.resolve(outputArg);
	const eloJsonPath = path.resolve(process.argv[4] || path.join("out", "teammate-elo.optimized.json"));

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

	const ratingIndex = buildRatingIndex(readJson(eloJsonPath));
	const predictedRows = predictRows(parsedCsv, ratingIndex, teammateIndexes, organizationIndex);

	const outputHeaders = [
		"predicted_rank",
		"predicted_elo_sum",
		"predicted_known_members",
		"predicted_unknown_members",
		"predicted_teammates",
		...parsedCsv.headers,
	];

	const outputRows = predictedRows.map((item) => [
		item.predictedRank,
		Math.round(item.eloSum),
		item.knownMembers,
		item.unknownMembers,
		item.teammateNames.join("; "),
		...item.originalRow,
	]);

	fs.mkdirSync(path.dirname(outputCsvPath), { recursive: true });
	fs.writeFileSync(outputCsvPath, stringifyCsv(outputHeaders, outputRows), "utf8");

	const totalKnown = predictedRows.reduce((sum, item) => sum + item.knownMembers, 0);
	const totalUnknown = predictedRows.reduce((sum, item) => sum + item.unknownMembers, 0);

	console.log(`Input CSV: ${inputCsvPath}`);
	console.log(`Output CSV: ${outputCsvPath}`);
	console.log(`Elo source: ${eloJsonPath}`);
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
