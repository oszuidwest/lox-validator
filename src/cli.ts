#!/usr/bin/env bun
import { readFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import packageJson from "../package.json";
import {
	buildReport,
	formatJson,
	formatText,
	oneLine,
	REPORT_FORMAT_VERSION,
	toSafeJson,
} from "./report.ts";
import { getRule, isRuleId, RULES } from "./rules.ts";
import type { Rule, ValidateOptions } from "./types.ts";

const STDIN_NAME = "<stdin>";

const HELP = `Validate a LOX v1 article submission (JSON) against the LOX format.

Usage:
  lox-validate [options] <file...|->   Validate files, or stdin with -
  lox-validate rules [--format json]   List all rules
  lox-validate explain <rule-id>       Explain one rule

A file literally named "rules" or "explain" is reachable as ./rules.

Options:
  --format text|json       Output format (default: text)
  --spec-dir <dir>         Also check against the LOX documents in this directory
                           (default: $LOX_SPEC_DIR)
  -h, --help               Show this help
  -v, --version            Show the version

Exit codes:
  0  No errors
  1  Errors in the submission
  2  Usage error, unreadable input, bad LOX documents or an internal failure
`;

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			format: { type: "string" },
			"spec-dir": { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
}

/**
 * Fatal errors must honour --format json even when the arguments themselves do not parse. A scan
 * by hand, not parseArgs: a lenient parse takes `--format --format json` as format "--format".
 */
function asksForJson(argv: string[]): boolean {
	let format: string | undefined;
	for (const [index, arg] of argv.entries()) {
		if (arg === "--") break;
		if (arg === "--format") format = argv[index + 1];
		else if (arg.startsWith("--format="))
			format = arg.slice("--format=".length);
	}
	return format === "json";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function decode(bytes: Uint8Array, name: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${name} is not valid UTF-8.`);
	}
}

function readFile(path: string): string {
	let bytes: Uint8Array;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${messageOf(error)}`);
	}
	return decode(bytes, path);
}

async function readStdin(): Promise<string> {
	const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
	return decode(bytes, STDIN_NAME);
}

async function readInputs(
	files: string[],
): Promise<{ file: string; input: string }[]> {
	// Not stdin by default: a caller that forgot its file would wait for as long as stdin stays open.
	if (files.length === 0) {
		throw new Error("No input: give a file, or - for stdin.");
	}
	if (files.filter((file) => file === "-").length > 1) {
		throw new Error("Stdin (-) can only be read once.");
	}
	const inputs: { file: string; input: string }[] = [];
	for (const file of files) {
		inputs.push(
			file === "-"
				? { file: STDIN_NAME, input: await readStdin() }
				: { file, input: readFile(file) },
		);
	}
	return inputs;
}

// Set before the first write to stdout: from then on a fatal error may not add a second document.
let stdoutUsed = false;

/** A pipe can take less than the whole text at once; wait until it has all been written. */
function print(text: string): Promise<void> {
	stdoutUsed = true;
	return new Promise((resolve, reject) => {
		process.stdout.write(text, (error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

function ruleLine(rule: Rule): string {
	return `${rule.id.padEnd(30)}${rule.severity.padEnd(9)}${rule.summary}`;
}

function explanation(rule: Rule): string {
	return `${rule.id} (${rule.severity})
${rule.summary}

Why:   ${rule.why}
Fix:   ${rule.fix}
Basis: ${rule.basis}
`;
}

async function runRules(positionals: string[], json: boolean): Promise<number> {
	if (positionals.length > 0) {
		throw new Error("rules takes no arguments.");
	}
	await print(
		json
			? `${JSON.stringify({ formatVersion: REPORT_FORMAT_VERSION, rules: RULES }, null, 2)}\n`
			: `${RULES.map(ruleLine).join("\n")}\n`,
	);
	return 0;
}

async function runExplain(
	positionals: string[],
	json: boolean,
): Promise<number> {
	const [id] = positionals;
	if (id === undefined || positionals.length > 1) {
		throw new Error("explain takes exactly one rule id.");
	}
	if (!isRuleId(id)) {
		throw new Error(
			`Unknown rule "${id}". Run lox-validate rules for the list.`,
		);
	}
	const rule = getRule(id);
	await print(
		json
			? `${JSON.stringify({ formatVersion: REPORT_FORMAT_VERSION, rule }, null, 2)}\n`
			: explanation(rule),
	);
	return 0;
}

async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parse(argv);
	if (values.help) {
		await print(HELP);
		return 0;
	}
	if (values.version) {
		await print(`${packageJson.version}\n`);
		return 0;
	}
	const format = values.format ?? "text";
	if (format !== "text" && format !== "json") {
		throw new Error("--format must be one of: text, json.");
	}
	const json = format === "json";

	const [command, ...commandArgs] = positionals;
	if (command === "rules" || command === "explain") {
		const stray = Object.keys(values).find((name) => name !== "format");
		if (stray !== undefined) {
			throw new Error(`--${stray} does not apply to ${command}.`);
		}
		return command === "rules"
			? runRules(commandArgs, json)
			: runExplain(commandArgs, json);
	}

	// join("", file) would read from the working directory instead of failing.
	if (values["spec-dir"] === "") {
		throw new Error("--spec-dir must not be empty.");
	}
	const specDir = values["spec-dir"] ?? process.env.LOX_SPEC_DIR;
	const options: ValidateOptions = specDir ? { specDir } : {};

	const inputs = await readInputs(positionals);
	// Imported late: a broken install would otherwise end in bun's own exit 1, which reads as
	// "errors in the submission" with no report to go with it.
	const { validate } = await import("./validate.ts");
	const entries = inputs.map(({ file, input }) => ({
		file,
		result: validate(input, options),
	}));

	const report = buildReport(entries);
	await print(
		json
			? formatJson(report)
			: formatText(
					report,
					process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
				),
	);
	return report.ok ? 0 : 1;
}

const argv = process.argv.slice(2);
const fatalAsJson = asksForJson(argv);

/**
 * All of `text`, also into a non-blocking pipe that takes part of it at a time. A reader that went
 * away must not hide the exit code, nor the message on the other stream.
 */
function tryWrite(fd: 1 | 2, text: string): void {
	const bytes = Buffer.from(text);
	let written = 0;
	while (written < bytes.length) {
		try {
			written += writeSync(fd, bytes, written);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EAGAIN") return;
			// The pipe is full: give the reader a moment.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
}

/** Synchronous: nothing else may run, or write, between the failure and the exit. */
function fail(error: unknown): never {
	const message = messageOf(error);
	if (fatalAsJson && !stdoutUsed) {
		tryWrite(
			1,
			`${toSafeJson({ formatVersion: REPORT_FORMAT_VERSION, fatal: message })}\n`,
		);
	}
	tryWrite(2, `lox-validate: ${oneLine(message)}\n`);
	// Explicit: a module still loading would keep the process alive.
	process.exit(2);
}

// Left to bun, an unhandled rejection exits 1, which reads as "errors in the submission".
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

// Failing is the default, so no path out of here can end in 0 by accident.
process.exitCode = 2;
try {
	process.exitCode = await run(argv);
} catch (error) {
	fail(error);
}
