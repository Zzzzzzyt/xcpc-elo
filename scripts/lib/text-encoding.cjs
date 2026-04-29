const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");
const chardet = require("chardet");
const { ensureDir } = require("./ranklist-utils.cjs");

const BOM_SIGNATURES = [
	{
		encoding: "utf32be",
		bytes: Buffer.from([0x00, 0x00, 0xfe, 0xff]),
		supported: false,
	},
	{
		encoding: "utf32le",
		bytes: Buffer.from([0xff, 0xfe, 0x00, 0x00]),
		supported: false,
	},
	{
		encoding: "utf8",
		bytes: Buffer.from([0xef, 0xbb, 0xbf]),
		supported: true,
	},
	{
		encoding: "utf16be",
		bytes: Buffer.from([0xfe, 0xff]),
		supported: true,
	},
	{
		encoding: "utf16le",
		bytes: Buffer.from([0xff, 0xfe]),
		supported: true,
	},
];

function detectBom(buffer) {
	for (const signature of BOM_SIGNATURES) {
		if (buffer.length >= signature.bytes.length && buffer.subarray(0, signature.bytes.length).equals(signature.bytes)) {
			return signature;
		}
	}
	return null;
}

function resolveSupportedEncoding(candidates) {
	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}
		if (iconv.encodingExists(candidate)) {
			return candidate;
		}
	}
	return null;
}

function detectEncodingFromBuffer(buffer) {
	const bom = detectBom(buffer);
	if (bom) {
		if (!bom.supported) {
			throw new Error(`Unsupported CSV BOM encoding: ${bom.encoding}.`);
		}
		return {
			encoding: bom.encoding,
			hadBom: true,
			bomBytes: bom.bytes,
			detectedBy: "bom",
			confidence: 100,
		};
	}

	const matches = chardet.analyse(buffer);
	const supportedMatch = matches.find((match) => iconv.encodingExists(match && match.name));
	if (supportedMatch) {
		return {
			encoding: supportedMatch.name,
			hadBom: false,
			bomBytes: Buffer.alloc(0),
			detectedBy: "chardet",
			confidence: supportedMatch.confidence,
		};
	}

	const fallbackEncoding = resolveSupportedEncoding([chardet.detect(buffer), buffer.length ? null : "utf8"]);
	if (fallbackEncoding) {
		return {
			encoding: fallbackEncoding,
			hadBom: false,
			bomBytes: Buffer.alloc(0),
			detectedBy: fallbackEncoding === "utf8" && !buffer.length ? "empty-file" : "chardet-fallback",
			confidence: null,
		};
	}

	throw new Error("Unable to detect a supported CSV encoding.");
}

function decodeBufferWithEncoding(buffer, encodingInfo) {
	const payload = encodingInfo.hadBom ? buffer.subarray(encodingInfo.bomBytes.length) : buffer;
	return iconv.decode(payload, encodingInfo.encoding);
}

function encodeTextWithEncoding(text, encodingInfo) {
	const body = iconv.encode(text, encodingInfo.encoding);
	if (encodingInfo.hadBom && encodingInfo.bomBytes.length) {
		return Buffer.concat([encodingInfo.bomBytes, body]);
	}
	return body;
}

function readTextFileWithDetectedEncoding(filePath) {
	const buffer = fs.readFileSync(filePath);
	const encodingInfo = detectEncodingFromBuffer(buffer);
	return {
		buffer,
		encodingInfo,
		text: decodeBufferWithEncoding(buffer, encodingInfo),
	};
}

function writeTextFileWithEncoding(filePath, text, encodingInfo) {
	const resolvedEncodingInfo = encodingInfo || {
		encoding: "utf8",
		hadBom: false,
		bomBytes: Buffer.alloc(0),
		detectedBy: "default",
		confidence: null,
	};
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, encodeTextWithEncoding(text, resolvedEncodingInfo));
}

function describeEncoding(encodingInfo) {
	const parts = [encodingInfo.encoding];
	if (encodingInfo.hadBom) {
		parts.push("BOM");
	}
	if (Number.isFinite(encodingInfo.confidence)) {
		parts.push(`confidence=${encodingInfo.confidence}`);
	}
	if (encodingInfo.detectedBy) {
		parts.push(`via ${encodingInfo.detectedBy}`);
	}
	return parts.join(", ");
}

module.exports = {
	decodeBufferWithEncoding,
	describeEncoding,
	detectEncodingFromBuffer,
	encodeTextWithEncoding,
	readTextFileWithDetectedEncoding,
	writeTextFileWithEncoding,
};
