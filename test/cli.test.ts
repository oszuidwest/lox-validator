import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildReport, formatText, oneLine } from "../src/report.ts";
import { RULES } from "../src/rules.ts";
import { OPENAPI_FILE, SCHEMA_FILE } from "../src/spec-documents.ts";
import {
	type Diagnostic,
	NOT_CHECKED,
	type ValidationResult,
} from "../src/types.ts";
import { minimal, pretty, SPEC_DIR, sha256 } from "./fixtures.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.ts");

// Every CLI run in this file starts while the tests are collected. On one CPU they queue behind
// each other, and the first awaited run can take longer than the default 5 s.
setDefaultTimeout(30_000);

const ARTICLE = minimal();
const CLEAN = pretty(ARTICLE);
/** One error: a block type the format does not have. */
const WITH_ERROR = pretty({
	...ARTICLE,
	body: [...ARTICLE.body, { type: "table" }],
});
/** One warning: a misspelled optional field. */
const WITH_WARNING = pretty({
	...ARTICLE,
	body: [
		...ARTICLE.body,
		{ type: "image", ref: "foto.jpg", captoin: "Onderschrift" },
	],
	media: [
		{
			ref: "foto.jpg",
			kind: "image",
			mimeType: "image/jpeg",
			delivery: { method: "url", url: "https://example.nl/foto.jpg" },
		},
	],
});

/** 1-based line and column of the first occurrence of `needle`. */
function positionOf(text: string, needle: string) {
	const offset = text.indexOf(needle);
	expect(offset).toBeGreaterThanOrEqual(0);
	const before = text.slice(0, offset).split("\n");
	return {
		line: before.length,
		column: (before.at(-1) ?? "").length + 1,
	};
}

/** Stand-ins for the LOX documents: they compile, constrain body and media, and match no tested version. */
const LIST_PART = { type: "array", items: { type: "object" } };
const FAKE_SCHEMA = JSON.stringify({
	properties: { body: LIST_PART, media: LIST_PART },
});
const FAKE_OPENAPI = JSON.stringify({
	components: {
		schemas: {
			ArticleSubmission: { properties: { body: LIST_PART, media: LIST_PART } },
		},
	},
});

// Made while the tests are collected, not in beforeAll: the describe blocks start their CLI runs
// right away, so the runs overlap and each test only awaits its own. Files a single test needs are
// written in its describe block, before the run that reads them.
const dir = mkdtempSync(join(tmpdir(), "lox-validate-"));
const path = (name: string) => join(dir, name);

function writeFakeSpecDir(target: string): void {
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, SCHEMA_FILE), FAKE_SCHEMA);
	writeFileSync(join(target, OPENAPI_FILE), FAKE_OPENAPI);
}

writeFileSync(path("clean.json"), CLEAN);
writeFileSync(path("error.json"), WITH_ERROR);
writeFileSync(path("warning.json"), WITH_WARNING);
writeFileSync(path("binary.json"), new Uint8Array([0x7b, 0x22, 0xff, 0xfe]));
mkdirSync(path("directory"));
writeFakeSpecDir(path("spec-dir"));

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

function envWithoutSpecDir(): Record<string, string | undefined> {
	const { LOX_SPEC_DIR: _, ...env } = process.env;
	return env;
}

async function run(
	args: string[],
	options: {
		stdin?: string | Uint8Array;
		cli?: string;
		env?: Record<string, string>;
	} = {},
): Promise<Run> {
	const child = Bun.spawn(["bun", options.cli ?? CLI, ...args], {
		cwd: dir,
		env: { ...envWithoutSpecDir(), ...options.env },
		stdin:
			typeof options.stdin === "string"
				? new TextEncoder().encode(options.stdin)
				: (options.stdin ?? "ignore"),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

/** Each key, in order, with the type of its value; an array stands for its first element. */
function shape(value: unknown): unknown {
	if (Array.isArray(value)) return [shape(value[0])];
	if (value === null) return "null";
	if (typeof value !== "object") return typeof value;
	return Object.entries(value).map(([key, item]) => [key, shape(item)]);
}

const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
/** The example report in AGENTS.md, without its comments (strings are kept whole). */
const DOCUMENTED_REPORT = JSON.parse(
	(AGENTS.match(/```jsonc\n([\s\S]*?)```/)?.[1] ?? "").replace(
		/("(?:[^"\\]|\\.)*")|\/\/.*/g,
		"$1",
	),
);
const DOCUMENTED_DIAGNOSTIC = DOCUMENTED_REPORT.results[0].diagnostics[0];

describe("fixtures", () => {
	const all = run([
		"clean.json",
		"error.json",
		"warning.json",
		"--format",
		"json",
	]);
	test("each fixture has exactly the findings its name promises", async () => {
		const results = JSON.parse((await all).stdout).results as {
			diagnostics: { ruleId: string; pointer: string }[];
		}[];
		expect(
			results.map((result) =>
				result.diagnostics.map((item) => [item.ruleId, item.pointer]),
			),
		).toEqual([
			[],
			[["format/violation", "/body/1/type"]],
			[["format/unknown-property", "/body/1/captoin"]],
		]);
	});
});

describe("exit codes", () => {
	test.each<[number, string, Promise<Run>]>([
		[0, "a clean file", run(["clean.json"])],
		[0, "--format text", run(["clean.json", "--format", "text"])],
		[0, "--format json", run(["clean.json", "--format", "json"])],
		[0, "warnings only", run(["warning.json"])],
		[1, "an error in the submission", run(["error.json"])],
	])("%d on %s", async (code, _name, pending) => {
		const result = await pending;
		expect(result.stderr).toBe("");
		expect(result.code).toBe(code);
	});

	const notJson = run(["-", "--format", "json"], { stdin: "<p>Tekst</p>" });
	test("1 on input that is not JSON", async () => {
		const { code, stdout } = await notJson;
		expect(code).toBe(1);
		expect(JSON.parse(stdout).results[0].diagnostics[0].ruleId).toBe(
			"json/syntax",
		);
	});

	const usageErrors: [string, string[], string][] = [
		["a missing file", ["missing.json"], "missing.json"],
		["a directory", ["directory"], "directory"],
		["invalid UTF-8", ["binary.json"], "not valid UTF-8"],
		["an unknown option", ["--bogus", "clean.json"], "--bogus"],
		["a missing option value", ["clean.json", "--format"], "--format"],
		["a bad --format", ["--format", "xml", "clean.json"], "--format"],
		// Stdin is never read by default: a forgotten file must not wait on an open stdin.
		["no input at all", [], "No input"],
		[
			"a missing --spec-dir",
			["--spec-dir", "nowhere", "clean.json"],
			"nowhere",
		],
		["stdin twice", ["-", "-"], "once"],
		["an unknown rule", ["explain", "no/such-rule"], "no/such-rule"],
		["explain without a rule", ["explain"], "explain"],
		["rules with an argument", ["rules", "extra"], "rules"],
		[
			"rules with a validation option",
			["rules", "--spec-dir", "x"],
			"--spec-dir",
		],
		[
			"explain with two rules",
			["explain", "media/unused", "json/syntax"],
			"one",
		],
	];
	test.each(
		usageErrors.map(
			([name, args, expected]) =>
				[name, run(args, { stdin: CLEAN }), expected] as const,
		),
	)("2 on %s", async (_name, pending, expected) => {
		const { code, stdout, stderr } = await pending;
		expect(code).toBe(2);
		expect(stdout).toBe("");
		expect(stderr).toContain(expected);
	});

	const oneMissing = run(["clean.json", "missing.json", "error.json"]);
	test("one unreadable file among good ones still gives 2", async () => {
		expect((await oneMissing).code).toBe(2);
	});

	const badEnvDir = run(["clean.json"], {
		env: { LOX_SPEC_DIR: path("nowhere") },
	});
	test("a bad LOX_SPEC_DIR gives 2", async () => {
		expect((await badEnvDir).code).toBe(2);
	});

	const broken = path("broken-spec");
	writeFakeSpecDir(broken);
	writeFileSync(join(broken, SCHEMA_FILE), "{");
	const brokenDocuments = run(["clean.json", "--spec-dir", broken]);
	test("LOX documents that are not JSON give 2", async () => {
		const { code, stderr } = await brokenDocuments;
		expect(code).toBe(2);
		expect(stderr).toContain(SCHEMA_FILE);
	});

	// The documents load before the input is read, so a bad --spec-dir cannot hide behind bad JSON.
	const badDirBadJson = run(["-", "--spec-dir", path("nowhere")], {
		stdin: "{",
	});
	test("a bad --spec-dir gives 2 also when the input is not JSON", async () => {
		expect((await badDirBadJson).code).toBe(2);
	});

	const emptySpecDir = [
		run(["clean.json", "--spec-dir", ""]),
		run(["clean.json", "--spec-dir", ""], {
			env: { LOX_SPEC_DIR: path("env-dir") },
		}),
	];
	const emptySpecDirEquals = run(["clean.json", "--spec-dir="]);
	test("an empty --spec-dir is a usage error, also with LOX_SPEC_DIR set", async () => {
		for (const { code, stderr } of await Promise.all(emptySpecDir)) {
			expect(code).toBe(2);
			expect(stderr).toContain("--spec-dir");
		}
		expect((await emptySpecDirEquals).code).toBe(2);
	});

	const emptyEnvDir = run(["clean.json", "--format", "json"], {
		env: { LOX_SPEC_DIR: "" },
	});
	test("an empty LOX_SPEC_DIR counts as unset", async () => {
		const { code, stdout } = await emptyEnvDir;
		expect(code).toBe(0);
		expect(JSON.parse(stdout).results[0].specCheck).toBeNull();
	});

	const envDir = run(["clean.json", "--format", "json"], {
		env: { LOX_SPEC_DIR: path("spec-dir") },
	});
	test("LOX_SPEC_DIR is used when --spec-dir is not given", async () => {
		const { code, stdout } = await envDir;
		expect(code).toBe(0);
		expect(JSON.parse(stdout).results[0].specCheck.dir).toBe(path("spec-dir"));
	});

	const flagAndEnvDir = run(["clean.json", "--spec-dir", path("flag-dir")], {
		env: { LOX_SPEC_DIR: path("env-dir") },
	});
	test("--spec-dir wins over LOX_SPEC_DIR", async () => {
		const { stderr } = await flagAndEnvDir;
		expect(stderr).toContain("flag-dir");
		expect(stderr).not.toContain("env-dir");
	});
});

describe("fatal errors with --format json", () => {
	// Not as the first argument: bun itself removes a `--` right after the script.
	const afterDashes = run(["missing", "--", "--format", "json"]);
	test("--format after -- is a file name, so the failure stays text", async () => {
		const { code, stdout } = await afterDashes;
		expect(code).toBe(2);
		expect(stdout).toBe("");
	});

	test.each(
		(
			[
				["a missing file", ["--format", "json", "missing.json"]],
				["an unknown option", ["--bogus", "--format=json", "clean.json"]],
				["an unknown rule", ["explain", "no/such-rule", "--format", "json"]],
				[
					"a missing --spec-dir",
					["--format=json", "--spec-dir", "nowhere", "clean.json"],
				],
				[
					"a --format without a value before the last one",
					["--format", "--format", "json", "clean.json"],
				],
			] as [string, string[]][]
		).map(([name, args]) => [name, run(args)] as const),
	)(
		"%s prints the fatal object on stdout and the message on stderr",
		async (_name, pending) => {
			const { code, stdout, stderr } = await pending;
			expect(code).toBe(2);
			const fatal = JSON.parse(stdout);
			expect(Object.keys(fatal)).toEqual(["formatVersion", "fatal"]);
			expect(fatal.formatVersion).toBe(3);
			expect(fatal.fatal.length).toBeGreaterThan(0);
			// stderr gives the message on one line.
			expect(stderr).toContain(oneLine(fatal.fatal));
		},
	);
});

const CLEAN_RESULT = `{ ok: true, summary: { errors: 0, warnings: 0 }, diagnostics: [], specCheck: null, notChecked: [] }`;

/** A copy of the CLI whose validator module fails as a broken install would. */
function brokenCli(body: string): string {
	const copy = mkdtempSync(join(dir, "broken-"));
	mkdirSync(join(copy, "src"));
	copyFileSync(join(ROOT, "package.json"), join(copy, "package.json"));
	for (const name of ["cli.ts", "report.ts", "rules.ts", "types.ts"]) {
		copyFileSync(join(ROOT, "src", name), join(copy, "src", name));
	}
	writeFileSync(join(copy, "src/validate.ts"), body);
	return join(copy, "src/cli.ts");
}

describe("unexpected failures", () => {
	const cannotLoad = run(["clean.json", "--format", "json"], {
		cli: brokenCli('throw new Error("cannot load");\n'),
	});
	test("a validator module that cannot load gives 2, not bun's 1", async () => {
		const { code, stdout, stderr } = await cannotLoad;
		expect(code).toBe(2);
		expect(JSON.parse(stdout).fatal).toContain("cannot load");
		expect(stderr).toContain("cannot load");
	});

	const throwing = run(["clean.json"], {
		cli: brokenCli(
			'export function validate() { throw new TypeError("internal"); }\n',
		),
	});
	test("an exception while validating gives 2", async () => {
		const { code, stderr } = await throwing;
		expect(code).toBe(2);
		expect(stderr).toContain("internal");
	});

	const sound = run(["clean.json"], {
		cli: brokenCli(`export function validate() { return ${CLEAN_RESULT}; }\n`),
	});
	test("the copied CLI runs when the module is sound", async () => {
		const { code, stderr } = await sound;
		expect(stderr).toBe("");
		expect(code).toBe(0);
	});

	test.each(
		[
			[
				"a throw from a timer",
				`setTimeout(() => { throw new Error("late"); }, 20);`,
				"late",
			],
			[
				"a thrown non-error from a timer",
				`setTimeout(() => { throw "a string"; }, 20);`,
				"a string",
			],
			[
				"an unhandled rejection",
				`Promise.reject(new Error("rejected"));`,
				"rejected",
			],
			[
				"a late unhandled rejection",
				`setTimeout(() => { Promise.reject(new Error("rejected")); }, 20);`,
				"rejected",
			],
		].map(([name = "", code = "", expected = ""]) => {
			const cli = brokenCli(
				`${code}\nexport function validate() { return ${CLEAN_RESULT}; }\n`,
			);
			return [
				name,
				run(["clean.json"], { cli }),
				run(["clean.json", "--format", "json"], { cli }),
				expected,
			] as const;
		}),
	)(
		"%s in the validator module gives 2, not validation errors",
		async (_name, pending, pendingJson, expected) => {
			for (const result of [await pending, await pendingJson]) {
				expect(result.code).toBe(2);
				expect(result.stderr).toContain(`lox-validate: ${expected}`);
			}
			// Before the report stdout holds the fatal object, after it the report alone: never both.
			const document = JSON.parse((await pendingJson).stdout);
			if ("fatal" in document) expect(document.fatal).toBe(expected);
			else expect(document.results).toHaveLength(1);
		},
	);

	// A pipe that takes 64 KiB at a time, read only after a while, as a slow reader would.
	test.skipIf(Bun.which("python3") === null)(
		"a long fatal message reaches a non-blocking pipe whole",
		async () => {
			const script = `
import fcntl, json, os, subprocess, sys, time
r, w = os.pipe()
fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) | os.O_NONBLOCK)
child = subprocess.Popen(sys.argv[1:], stdout=w, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
os.close(w)
time.sleep(0.3)
data = b""
while chunk := os.read(r, 65536):
    data += chunk
print(child.wait(), json.loads(data)["fatal"].startswith(f"Unknown option '{sys.argv[-1]}'"))
`;
			const option = `--${"x".repeat(100_000)}`;
			const child = Bun.spawn(
				["python3", "-I", "-c", script, "bun", CLI, "--format", "json", option],
				{ cwd: dir, env: envWithoutSpecDir(), stdout: "pipe" },
			);
			expect(await new Response(child.stdout).text()).toBe("2 True\n");
		},
	);

	const earlyCrash = run(["clean.json", "--format", "json"], {
		cli: brokenCli(
			`setTimeout(() => { throw new Error("early"); }, 20);\nawait new Promise((resolve) => setTimeout(resolve, 2000));\nexport function validate() { return ${CLEAN_RESULT}; }\n`,
		),
	});
	test("a throw from a timer before the report gives the fatal object", async () => {
		const { code, stdout, stderr } = await earlyCrash;
		expect(code).toBe(2);
		expect(JSON.parse(stdout)).toEqual({ formatVersion: 3, fatal: "early" });
		expect(stderr).toBe("lox-validate: early\n");
	});

	const depth = 200_000;
	writeFileSync(path("deep.json"), `${"[".repeat(depth)}${"]".repeat(depth)}`);
	const deep = run(["deep.json", "--format", "json"]);
	test("input nested too deep is an error in the submission, not a crash or a pass", async () => {
		const { code, stdout } = await deep;
		expect(code).toBe(1);
		const report = JSON.parse(stdout);
		expect(report.ok).toBe(false);
		expect(report.results[0].diagnostics[0].ruleId).toBe("json/syntax");
	});
});

describe("stdin", () => {
	const dash = run(["-", "--format", "json"], { stdin: WITH_ERROR });
	test("- reads stdin", async () => {
		const { code, stdout } = await dash;
		expect(code).toBe(1);
		const [result] = JSON.parse(stdout).results;
		expect(result.file).toBe("<stdin>");
		expect(result.diagnostics[0].ruleId).toBe("format/violation");
		expect(result.diagnostics[0].pointer).toBe("/body/1/type");
	});

	const emptyDash = run(["-", "--format", "json"], { stdin: "" });
	test("an explicit empty - is validated, and is not JSON", async () => {
		const { code, stdout } = await emptyDash;
		expect(code).toBe(1);
		const ids = JSON.parse(stdout).results[0].diagnostics.map(
			(item: { ruleId: string }) => item.ruleId,
		);
		expect(ids).toEqual(["json/syntax"]);
	});

	test("without input it stops at once, also while stdin stays open", async () => {
		const child = Bun.spawn(["bun", CLI], {
			cwd: dir,
			env: envWithoutSpecDir(),
			stdin: "pipe",
			stderr: "pipe",
		});
		const code = await Promise.race([
			child.exited,
			Bun.sleep(10_000).then(() => "still waiting"),
		]);
		child.stdin.end();
		child.kill();
		expect(code).toBe(2);
		expect(await new Response(child.stderr).text()).toContain("No input");
	});

	const binary = run(["-"], { stdin: new Uint8Array([0xff, 0xfe, 0x7b]) });
	test("invalid UTF-8 on stdin gives 2", async () => {
		expect((await binary).code).toBe(2);
	});

	const mixed = run(["clean.json", "-", "--format", "json"], { stdin: CLEAN });
	test("- can be mixed with files, in order", async () => {
		const files = JSON.parse((await mixed).stdout).results.map(
			(result: { file: string }) => result.file,
		);
		expect(files).toEqual(["clean.json", "<stdin>"]);
	});
});

const ruleFix = (id: string) =>
	RULES.find((rule) => rule.id === id)?.fix ?? "missing";

describe("JSON report", () => {
	const error = run(["error.json", "--format", "json"]);
	test("gives the values of the finding and the totals", async () => {
		const report = JSON.parse((await error).stdout);
		expect(report.formatVersion).toBe(3);
		expect(report.ok).toBe(false);
		expect(report.notChecked).toEqual([...NOT_CHECKED]);
		expect(report.summary).toEqual({
			files: 1,
			errors: 1,
			warnings: 0,
		});

		const [result] = report.results;
		expect(result.file).toBe("error.json");
		expect(result.ok).toBe(false);
		expect(result.summary).toEqual({ errors: 1, warnings: 0 });
		expect(result.specCheck).toBeNull();

		const [item] = result.diagnostics;
		const start = positionOf(WITH_ERROR, '"table"');
		const offset = WITH_ERROR.indexOf('"table"');
		expect(item).toEqual({
			ruleId: "format/violation",
			severity: "error",
			message: expect.stringContaining("table"),
			fix: ruleFix("format/violation"),
			range: {
				line: start.line,
				column: start.column,
				endLine: start.line,
				endColumn: start.column + '"table"'.length,
				offset,
				endOffset: offset + '"table"'.length,
			},
			excerpt: '"table"',
			pointer: "/body/1/type",
		});
	});

	const warning = run(["warning.json", "--format", "json"]);
	test("a finding with its own fix gives that fix, not the catalog's", async () => {
		const [item] = JSON.parse((await warning).stdout).results[0].diagnostics;
		expect(item.ruleId).toBe("format/unknown-property");
		expect(item.severity).toBe("warning");
		expect(item.message).toContain("caption");
		expect(item.fix).not.toBe(ruleFix("format/unknown-property"));
		expect(item.fix).toContain("caption");
		expect(item.excerpt).toBe('"captoin"');
		expect({ line: item.range.line, column: item.range.column }).toEqual(
			positionOf(WITH_WARNING, '"captoin"'),
		);
	});

	const clean = run(["clean.json", "--format", "json"]);
	test("notChecked names what ok cannot vouch for", async () => {
		const report = JSON.parse((await clean).stdout);
		expect(report.ok).toBe(true);
		const text = report.notChecked.join("\n");
		for (const word of [
			"reachable",
			"redirects",
			"MIME",
			"byteSize",
			"checksum",
			"Uploading",
			"embed",
			"unique",
			"Rights",
			"tenant",
			"authentication",
			"LOX server",
		]) {
			expect(text).toContain(word);
		}
	});

	const specDir = path("spec-dir");
	const withSpecDir = run([
		"clean.json",
		"--format",
		"json",
		"--spec-dir",
		specDir,
	]);
	test("a diagnostic without a position has a null range and still has a fix", async () => {
		const [item] = JSON.parse((await withSpecDir).stdout).results[0]
			.diagnostics;
		expect(item.ruleId).toBe("spec/changed");
		expect(Object.keys(item)).toEqual(Object.keys(DOCUMENTED_DIAGNOSTIC));
		expect(item.range).toBeNull();
		expect(item.excerpt).toBeNull();
		expect(item.pointer).toBeNull();
		expect(item.fix).toBe(ruleFix("spec/changed"));
	});

	test("--spec-dir gives specCheck its full shape, with hashes of the bytes read", async () => {
		const { code, stdout } = await withSpecDir;
		expect(code).toBe(0);
		const [result] = JSON.parse(stdout).results;
		expect(result.specCheck).toEqual({
			dir: specDir,
			schemaSha256: sha256(FAKE_SCHEMA),
			openapiSha256: sha256(FAKE_OPENAPI),
			matchesTested: false,
		});
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].ruleId).toBe("spec/changed");
		expect(result.diagnostics[0].severity).toBe("warning");
	});
});

describe("the fixtures against the LOX documents in spec/", () => {
	test.each(
		(
			[
				["the clean fixture", "clean.json", []],
				["the error fixture", "error.json", ["format/violation"]],
				["the warning fixture", "warning.json", ["format/unknown-property"]],
				["the example", join(ROOT, "examples/article.json"), []],
			] as [string, string, string[]][]
		).map(
			([name, file, expected]) =>
				[
					name,
					run([file, "--format", "json", "--spec-dir", SPEC_DIR]),
					expected,
				] as const,
		),
	)(
		"%s has the same findings with the documents as without",
		async (_name, pending, expected) => {
			const { code, stdout, stderr } = await pending;
			expect(stderr).toBe("");
			expect(code).toBe(expected.includes("format/violation") ? 1 : 0);
			const [result] = JSON.parse(stdout).results;
			expect(result.specCheck.matchesTested).toBe(true);
			expect(
				result.diagnostics.map((item: { ruleId: string }) => item.ruleId),
			).toEqual(expected);
		},
	);
});

describe("several files", () => {
	const three = run([
		"clean.json",
		"error.json",
		"warning.json",
		"--format",
		"json",
	]);
	test("each gets a result, in the order given, and the totals add up", async () => {
		const { code, stdout } = await three;
		expect(code).toBe(1);
		const report = JSON.parse(stdout);
		expect(report.ok).toBe(false);
		expect(report.summary).toEqual({
			files: 3,
			errors: 1,
			warnings: 1,
		});
		expect(
			report.results.map((result: { file: string; ok: boolean }) => [
				result.file,
				result.ok,
			]),
		).toEqual([
			["clean.json", true],
			["error.json", false],
			["warning.json", true],
		]);
	});
});

describe("text output", () => {
	const two = run(["error.json", "warning.json"]);
	test("gives position, severity, rule, message, fix and a summary", async () => {
		const lines = (await two).stdout.trimEnd().split("\n");
		const error = positionOf(WITH_ERROR, '"table"');
		const warning = positionOf(WITH_WARNING, '"captoin"');
		expect(lines[0]).toStartWith(
			`error.json:${error.line}:${error.column}  error  format/violation  `,
		);
		expect(lines[1]).toBe(`  fix: ${ruleFix("format/violation")}`);
		expect(lines[2]).toStartWith(
			`warning.json:${warning.line}:${warning.column}  warning  format/unknown-property  `,
		);
		expect(lines[3]).toStartWith("  fix: ");
		expect(lines[4]).toBe("1 error, 1 warning in 2 files");
		expect(lines).toHaveLength(5);
	});

	const clean = run(["clean.json"]);
	test("a clean file prints only the summary", async () => {
		expect((await clean).stdout).toBe("0 errors, 0 warnings in 1 file\n");
	});

	const noPosition = run(["-", "--spec-dir", path("spec-dir")], {
		stdin: CLEAN,
	});
	test("a diagnostic without a position has no line and column", async () => {
		expect((await noPosition).stdout.split("\n")[0]).toMatch(
			/^<stdin> {2}warning {2}spec\/changed {2}\S/,
		);
	});

	const error = run(["error.json"]);
	test("piped output has no colour codes", async () => {
		expect((await error).stdout).not.toContain("\u001b");
	});
});

describe("formatText", () => {
	const result = (message: string): ValidationResult => ({
		ok: false,
		summary: { errors: 1, warnings: 0 },
		diagnostics: [
			{
				ruleId: "format/violation",
				severity: "error",
				message,
				fix: "y",
				range: null,
				excerpt: null,
				pointer: null,
			},
		],
		specCheck: null,
		notChecked: NOT_CHECKED,
	});
	const report = (message: string) =>
		buildReport([{ file: "a.json", result: result(message) }]);

	test("colours the severity only when asked", () => {
		expect(formatText(report("x"), true)).toContain("\u001b[31merror\u001b[0m");
		expect(formatText(report("x"), false)).not.toContain("\u001b");
	});

	test("input quoted in a message cannot break a line or drive the terminal", () => {
		const text = formatText(report("a\nb\u001b[2Jc"), false);
		expect(text).not.toContain("\u001b");
		expect(text.split("\n")[0]).toContain("a b [2Jc");
	});

	test.each([
		["a newline", "\n"],
		["a carriage return", "\r"],
		["an escape", "\u001b"],
		["a next line", "\u0085"],
		["a line separator", "\u2028"],
		["a paragraph separator", "\u2029"],
		["a right-to-left override", "\u202e"],
		["a bidi isolate", "\u2066"],
	])(
		"%s in a file name, message or fix stays out of the text",
		(_name, char) => {
			const hostile = `x${char}y`;
			const built = buildReport([
				{
					file: hostile,
					result: {
						...result(hostile),
						diagnostics: [
							{
								...(result("").diagnostics[0] as Diagnostic),
								message: hostile,
								fix: hostile,
							},
						],
					},
				},
			]);
			const lines = formatText(built, false).split("\n");
			expect(lines[0]).toBe("x y  error  format/violation  x y");
			expect(lines[1]).toBe("  fix: x y");
			expect(lines[2]).toStartWith("1 error");
			expect(lines).toHaveLength(4);
		},
	);

	const hostileRule = run(["explain", "a\u001b[2J\u202eb"]);
	test("a message on stderr cannot drive the terminal either", async () => {
		const { code, stderr } = await hostileRule;
		expect(code).toBe(2);
		expect(stderr).toBe(
			'lox-validate: Unknown rule "a [2J b". Run lox-validate rules for the list.\n',
		);
	});

	const key = `a\u001b[2J\u202eb\u2028c`;
	const hostileKey = run(["-"], { stdin: pretty({ ...ARTICLE, [key]: 1 }) });
	test("input quoted in a real report cannot drive the terminal", async () => {
		const { stdout } = await hostileKey;
		const [first] = stdout.split("\n");
		expect(first).toContain("format/unknown-property");
		expect(first).toContain("[2J b c");
		for (const char of ["\u001b", "\u202e", "\u2028"]) {
			expect(stdout).not.toContain(char);
		}
	});
});

describe("large output", () => {
	const blocks = 5_000;
	writeFileSync(
		path("big.json"),
		pretty({
			...ARTICLE,
			body: Array.from({ length: blocks }, () => ({ type: "table" })),
		}),
	);

	test("reaches a slow reader in full", async () => {
		const child = Bun.spawn(["bun", CLI, "big.json", "--format", "json"], {
			cwd: dir,
			env: envWithoutSpecDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const chunks: Uint8Array[] = [];
		for await (const chunk of child.stdout) {
			// The report has started, and the pipe buffer is far smaller than the report, so the
			// writer has to wait for us.
			if (chunks.length === 0) await Bun.sleep(100);
			chunks.push(chunk);
		}
		const stdout = Buffer.concat(chunks).toString("utf8");
		expect(await child.exited).toBe(1);
		const report = JSON.parse(stdout);
		expect(stdout.length).toBeGreaterThan(1_000_000);
		const diagnostics = report.results[0].diagnostics as { pointer: string }[];
		expect(
			diagnostics.filter((item) => /^\/body\/\d+\/type$/.test(item.pointer)),
		).toHaveLength(blocks);
		expect(diagnostics).toHaveLength(report.summary.errors);
	}, 30_000);
});

/** Literal on purpose: the severity decides `ok`, so a test must not read it from the catalog. */
const SEVERITIES = {
	"block/blank": "warning",
	"delivery/internal-url": "error",
	"delivery/upload-incomplete": "error",
	"delivery/upload-url": "error",
	"format/not-in-submission": "warning",
	"format/unknown-property": "warning",
	"format/violation": "error",
	"input/too-large": "error",
	"json/duplicate-key": "error",
	"json/invalid-string": "error",
	"json/syntax": "error",
	"media/duplicate-ref": "error",
	"media/duration-on-image": "warning",
	"media/kind-mismatch": "error",
	"media/mime-kind": "warning",
	"media/undeclared-ref": "error",
	"media/unused": "warning",
	"spec/changed": "warning",
	"spec/violation": "error",
	"text/markup": "warning",
	"text/newline": "warning",
};

describe("rules and explain", () => {
	const rules = run(["rules"]);
	test("rules lists every rule", async () => {
		const { code, stdout } = await rules;
		expect(code).toBe(0);
		for (const rule of RULES) {
			expect(stdout).toContain(rule.id);
		}
		expect(stdout.trimEnd().split("\n")).toHaveLength(RULES.length);
	});

	const rulesJson = run(["rules", "--format", "json"]);
	test("rules --format json gives the full catalog, each rule with its agreed severity and every field filled", async () => {
		const { code, stdout } = await rulesJson;
		expect(code).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Object.keys(parsed).sort()).toEqual(["formatVersion", "rules"]);
		expect(parsed.formatVersion).toBe(3);
		expect(parsed.rules).toEqual(JSON.parse(JSON.stringify(RULES)));
		const catalog = parsed.rules as Record<string, string>[];
		expect(
			Object.fromEntries(catalog.map((rule) => [rule.id, rule.severity])),
		).toEqual(SEVERITIES);
		for (const rule of catalog) {
			expect(Object.keys(rule).sort()).toEqual([
				"basis",
				"fix",
				"id",
				"severity",
				"summary",
				"why",
			]);
			for (const value of Object.values(rule)) {
				expect(value.length).toBeGreaterThan(0);
			}
		}
	});

	const explain = run(["explain", "media/unused"]);
	test("explain gives severity, why, fix and basis", async () => {
		const { code, stdout } = await explain;
		expect(code).toBe(0);
		const rule = RULES.find((item) => item.id === "media/unused");
		expect(stdout.split("\n")[0]).toBe("media/unused (warning)");
		expect(stdout).toContain(rule?.why ?? "missing");
		expect(stdout).toContain(rule?.fix ?? "missing");
		expect(stdout).toContain(rule?.basis ?? "missing");
	});

	const explainJson = run(["explain", "media/unused", "--format=json"]);
	test("explain --format json gives the rule", async () => {
		const parsed = JSON.parse((await explainJson).stdout);
		expect(parsed.formatVersion).toBe(3);
		expect(parsed.rule).toEqual(
			JSON.parse(
				JSON.stringify(RULES.find((item) => item.id === "media/unused")),
			),
		);
	});

	writeFileSync(path("rules"), WITH_ERROR);
	const rulesFile = run(["./rules", "--format", "json"]);
	test("a file named rules is reachable as ./rules", async () => {
		const { code, stdout } = await rulesFile;
		expect(code).toBe(1);
		expect(JSON.parse(stdout).results[0].file).toBe("./rules");
	});
});

const packageJson = JSON.parse(
	readFileSync(join(ROOT, "package.json"), "utf8"),
);

describe("entry points", () => {
	const help = run(["--help"]);
	test("--help prints usage and exits 0", async () => {
		const { code, stdout } = await help;
		expect(code).toBe(0);
		for (const word of [
			"lox-validate",
			"--format",
			"--spec-dir",
			"LOX_SPEC_DIR",
			"Exit codes",
		]) {
			expect(stdout).toContain(word);
		}
	});

	const version = run(["--version"]);
	test("--version prints the package version", async () => {
		const { code, stdout } = await version;
		expect(code).toBe(0);
		expect(stdout.trim()).toBe(packageJson.version);
	});

	test("the bin entry is executable and runs under its shebang", async () => {
		const { bin } = packageJson;
		expect(Object.keys(bin)).toEqual(["lox-validate"]);
		const entry = resolve(ROOT, bin["lox-validate"]);
		expect(entry).toBe(CLI);
		expect(statSync(entry).mode & 0o111).toBe(0o111);
		const child = Bun.spawn([entry, "--version"], { stdout: "pipe" });
		expect(await child.exited).toBe(0);
	});
});

describe("the documentation", () => {
	test.each(["AGENTS.md", "README.md"])(
		"%s pins every bunx command to the package version",
		(name) => {
			const docs = readFileSync(join(ROOT, name), "utf8");
			const commands = docs.match(/bunx github:oszuidwest\/lox-\S*/g) ?? [];
			expect(commands.length).toBeGreaterThan(0);
			for (const command of commands) {
				expect(command).toBe(
					`bunx github:oszuidwest/lox-validator#v${packageJson.version}`,
				);
			}
		},
	);

	const error = run(["error.json", "--format", "json"]);
	const withSpecDir = run([
		"clean.json",
		"--format",
		"json",
		"--spec-dir",
		path("spec-dir"),
	]);
	test("AGENTS.md shows the JSON report with every key, in order, and the type of each value", async () => {
		expect(shape(JSON.parse((await error).stdout))).toEqual(
			shape(DOCUMENTED_REPORT),
		);
		// The example has no specCheck; the comment next to it lists the keys.
		const keys = AGENTS.match(/"specCheck": null \/\/ \{ ([^}]*) \}/)?.[1];
		const [result] = JSON.parse((await withSpecDir).stdout).results;
		expect(Object.keys(result.specCheck)).toEqual(keys?.split(", ") ?? []);
	});

	test("README.md shows a diagnostic in the shape of the report", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		const example = JSON.parse(
			readme.match(/```json\n([\s\S]*?)```/)?.[1] ?? "",
		);
		expect(shape(example)).toEqual(shape(DOCUMENTED_DIAGNOSTIC));
	});

	test("AGENTS.md lists what ok does not cover as notChecked does", () => {
		const section = AGENTS.split("## What `ok` means")[1]?.split("\n## ")[0];
		const items = [...(section ?? "").matchAll(/^- (.+)$/gm)].map(
			([, item = ""]) => item.replaceAll("`", ""),
		);
		// AGENTS.md starts each item in lower case and puts field names in backticks.
		expect(items).toEqual(
			NOT_CHECKED.map((item) => item[0]?.toLowerCase() + item.slice(1)),
		);
	});

	const stdin = run(["-", "--format", "json"], { stdin: CLEAN });
	test("the report says which version ran", async () => {
		expect(JSON.parse((await stdin).stdout).validatorVersion).toBe(
			packageJson.version,
		);
	});
});

describe("display spoofing in JSON output", () => {
	/** A submission with an unknown property of this name, which the report quotes. */
	const withKey = (key: string) =>
		run(["-", "--format", "json"], { stdin: pretty({ ...ARTICLE, [key]: 1 }) });

	const c1 = String.fromCodePoint(0x9b);
	const tag = String.fromCodePoint(0xe0041);
	const override = String.fromCodePoint(0x202e);
	const separator = String.fromCodePoint(0x2028);

	const c1Key = `a${c1}b${tag}c`;
	const c1Run = withKey(c1Key);
	test("C1 controls and characters beyond the BMP are escaped and parse back", async () => {
		const { stdout } = await c1Run;
		expect(stdout).not.toContain(c1);
		expect(stdout).not.toContain(tag);
		expect(stdout).toContain("\\u009b");
		const [item] = JSON.parse(stdout).results[0].diagnostics;
		expect(item.ruleId).toBe("format/unknown-property");
		expect(item.excerpt).toBe(JSON.stringify(c1Key));
		expect(item.pointer).toBe(`/${c1Key}`);
		expect(item.message).toContain(c1Key);
	});

	const fatal = run(
		["-", "--format", "json", "--spec-dir", `/no-such-${override}dir`],
		{ stdin: CLEAN },
	);
	test("the fatal report escapes them too", async () => {
		const { code, stdout } = await fatal;
		expect(code).toBe(2);
		expect(stdout).not.toContain(override);
		expect(JSON.parse(stdout).fatal).toContain(override);
	});

	const bidiKey = `a${override}b${separator}c`;
	const bidiRun = withKey(bidiKey);
	test("bidi controls and line separators are escaped, and parse back unchanged", async () => {
		const { stdout } = await bidiRun;
		expect(stdout).not.toContain(override);
		expect(stdout).not.toContain(separator);
		expect(stdout).toContain("\\u202e");
		expect(stdout).toContain("\\u2028");
		const [item] = JSON.parse(stdout).results[0].diagnostics;
		expect(item.excerpt).toBe(JSON.stringify(bidiKey));
		expect(item.pointer).toBe(`/${bidiKey}`);
	});
});
