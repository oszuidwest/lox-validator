import { describe, expect, test } from "bun:test";
import { getRule, RULES } from "../src/rules.ts";
import {
	type Diagnostic,
	NOT_CHECKED,
	type ValidationResult,
} from "../src/types.ts";
import { MAX_INPUT_LENGTH, validate } from "../src/validate.ts";
import {
	EXAMPLE_TEXT,
	example,
	full,
	type Json,
	minimal,
	paragraph,
	pretty,
	text,
	variant,
} from "./fixtures.ts";

const ruleIds = (result: ValidationResult) =>
	result.diagnostics.map((item) => item.ruleId);
const find = (result: ValidationResult, ruleId: string) => {
	const found = result.diagnostics.find((item) => item.ruleId === ruleId);
	if (found === undefined)
		throw new Error(`no ${ruleId} in ${ruleIds(result)}`);
	return found;
};
/** 1-based line and column of `offset` in `input`. */
const position = (input: string, offset: number) => {
	const before = input.slice(0, offset);
	const line = before.split("\n").length;
	return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
};
const expectRange = (
	input: string,
	item: Diagnostic,
	text: string,
	from = 0,
) => {
	const offset = input.indexOf(text, from);
	expect(offset).toBeGreaterThanOrEqual(0);
	const start = position(input, offset);
	const end = position(input, offset + text.length);
	expect(item.range).toEqual({
		line: start.line,
		column: start.column,
		endLine: end.line,
		endColumn: end.column,
		offset,
		endOffset: offset + text.length,
	});
	expect(item.excerpt).toBe(text.slice(0, 120));
};

describe("a valid submission", () => {
	test("the example has no diagnostics and is ok", () => {
		const result = validate(EXAMPLE_TEXT);
		expect(result).toEqual({
			ok: true,
			summary: { errors: 0, warnings: 0 },
			diagnostics: [],
			specCheck: null,
			notChecked: NOT_CHECKED,
		});
	});

	test("the full and minimal fixtures have no diagnostics", () => {
		expect(validate(pretty(full())).diagnostics).toEqual([]);
		expect(validate(JSON.stringify(minimal())).diagnostics).toEqual([]);
	});

	test("notChecked is always the same constant", () => {
		for (const input of [EXAMPLE_TEXT, "{", "[]", pretty({ title: "" })]) {
			expect(validate(input).notChecked).toBe(NOT_CHECKED);
		}
	});
});

describe("positions", () => {
	test("a missing property points at its object", () => {
		const input = pretty(
			variant(example(), (a) => {
				delete a.metadata.timestamps;
			}),
		);
		const item = find(validate(input), "format/violation");
		expect(item.pointer).toBe("/metadata");
		expect(item.message).toBe('metadata is missing required "timestamps"');
		const start = input.indexOf("{", input.indexOf('"metadata"'));
		const end = input.indexOf("\n  },", start) + 4;
		expectRange(input, item, input.slice(start, end));
	});

	test("a missing top-level property points at the whole document", () => {
		const input = pretty(
			variant(example(), (a) => {
				delete a.title;
			}),
		);
		const item = find(validate(input), "format/violation");
		expect(item.pointer).toBe("");
		expect(item.range?.offset).toBe(0);
		expect(item.range?.endOffset).toBe(input.length);
		expect(item.excerpt).toHaveLength(120);
	});

	test("a wrong value points at the value", () => {
		const input = pretty(
			variant(example(), (a) => {
				a.metadata.locale = "nl_NL";
			}),
		);
		const item = find(validate(input), "format/violation");
		expect(item.pointer).toBe("/metadata/locale");
		expectRange(input, item, '"nl_NL"');
	});

	test("an unknown property points at its key", () => {
		const input = pretty(
			variant(example(), (a) => {
				delete a.hero.caption;
				a.hero.captoin = "x";
			}),
		);
		const item = find(validate(input), "format/unknown-property");
		expect(item.pointer).toBe("/hero/captoin");
		expectRange(input, item, '"captoin"');
		expect(item.fix).toBe('Rename "captoin" to "caption".');
	});

	test("an unknown property next to the field it resembles gets no suggestion", () => {
		const input = pretty(
			variant(example(), (a) => {
				a.hero.Caption = "x";
			}),
		);
		const item = find(validate(input), "format/unknown-property");
		expect(item.message).toBe(
			'"Caption" is not a field here; known fields are ref, caption',
		);
		expect(item.fix).toBe(getRule("format/unknown-property").fix);
	});

	test("a field outside the submission points at its key and is still validated", () => {
		const input = pretty({ ...example(), formatVersion: "2.0" });
		const result = validate(input);
		expect(ruleIds(result).sort()).toEqual([
			"format/not-in-submission",
			"format/violation",
		]);
		expectRange(
			input,
			find(result, "format/not-in-submission"),
			'"formatVersion"',
		);
		expectRange(input, find(result, "format/violation"), '"2.0"');
		expect(result.ok).toBe(false);
	});

	test("upload delivery with a url points at the url key", () => {
		const input = pretty(
			variant(example(), (a) => {
				a.media[0].delivery = { method: "upload", url: "https://x.nl/a.jpg" };
				a.media[0].byteSize = 5;
				a.media[0].checksum = { algorithm: "md5", value: "0".repeat(32) };
			}),
		);
		const item = find(validate(input), "delivery/upload-url");
		expectRange(input, item, '"url"', input.indexOf('"method": "upload"'));
	});

	test("a duplicate key points at the second key and names the first position", () => {
		const input = '{\n  "title": "a",\n  "title": "b"\n}';
		const item = find(validate(input), "json/duplicate-key");
		expect(item.pointer).toBe("/title");
		expectRange(input, item, '"title"', 10);
		expect(item.message).toBe(
			'"title" appears again; the first is at line 2, column 3',
		);
	});

	test("a duplicate key with ~ or / in its name is named unescaped", () => {
		const item = find(validate('{"a/b~": 1, "a/b~": 2}'), "json/duplicate-key");
		expect(item.pointer).toBe("/a~1b~0");
		expect(item.message).toStartWith('"a/b~" appears again');
	});

	test("a lone surrogate points at its string", () => {
		const input = pretty(example()).replace('"Redactie"', '"Re\\ud800dactie"');
		const item = find(validate(input), "json/invalid-string");
		expect(item.pointer).toBe("/metadata/authors/0/name");
		expectRange(input, item, '"Re\\ud800dactie"');
	});

	test("a syntax error points at the offending character", () => {
		const input = '{\n  "title": "a",\n  "body": [1,]\n}';
		const result = validate(input);
		expect(result.diagnostics).toEqual([
			{
				ruleId: "json/syntax",
				severity: "error",
				message: "Invalid JSON: trailing comma before ]",
				fix: getRule("json/syntax").fix,
				range: {
					line: 3,
					column: 14,
					endLine: 3,
					endColumn: 15,
					offset: input.indexOf("]"),
					endOffset: input.indexOf("]") + 1,
				},
				excerpt: "]",
				pointer: null,
			},
		]);
	});

	test("a syntax error at the end of the input has an empty range there", () => {
		const item = find(validate("[1, 2"), "json/syntax");
		expect(item.range).toMatchObject({
			line: 1,
			column: 6,
			offset: 5,
			endOffset: 5,
		});
		expect(item.excerpt).toBe("");
	});

	test("columns on CRLF lines start after the line feed", () => {
		const input = pretty(
			variant(example(), (a) => {
				a.title = "";
			}),
		).replaceAll("\n", "\r\n");
		const item = find(validate(input), "format/violation");
		const offset = input.indexOf('"title": ""') + 9;
		const before = input.slice(0, offset);
		expect(item.range?.line).toBe(before.split("\n").length);
		expect(item.range?.column).toBe(offset - before.lastIndexOf("\n"));
	});

	test("a long excerpt is cut at 120 characters", () => {
		const input = pretty({ ...example(), title: "x".repeat(1001) });
		const item = find(validate(input), "format/violation");
		expect(item.excerpt).toBe(`"${"x".repeat(119)}`);
		expect(item.range?.endOffset).toBe((item.range?.offset ?? 0) + 1003);
	});

	test("findings of the checks carry ranges at their pointer", () => {
		const input = pretty(
			variant(example(), (a) => {
				a.body.push({ type: "image", ref: "missing.jpg" });
			}),
		);
		const item = find(validate(input), "media/undeclared-ref");
		expect(item.pointer).toBe("/body/5/ref");
		expectRange(input, item, '"missing.jpg"');
	});

	test("every diagnostic of a messy submission has a range inside the input", () => {
		const input = pretty(messy());
		for (const item of validate(input).diagnostics) {
			expect(item.range).not.toBeNull();
			const range = item.range as NonNullable<Diagnostic["range"]>;
			expect(range.offset).toBeLessThanOrEqual(range.endOffset);
			expect(range.endOffset).toBeLessThanOrEqual(input.length);
			expect(item.excerpt).toBe(
				input.slice(
					range.offset,
					Math.min(range.endOffset, range.offset + 120),
				),
			);
		}
	});
});

/** A submission with something for nearly every rule. */
const messy = (): Json =>
	variant(full(), (a) => {
		a.formatVersion = "1.0";
		a.title = "Kop <b>vet</b>\n";
		a.hero.captoin = "x";
		a.body[0].content[0].text = "&nbsp;";
		a.body[1].level = 9;
		a.body.push(paragraph(text(" ")));
		a.body.push({ type: "image", ref: "missing.jpg" });
		a.body.push({ type: "audio", ref: "hero.jpg" });
		a.media[0].durationSeconds = 3;
		a.media[1].delivery = { method: "upload", url: "x" };
		a.media[2].mimeType = "audio/mpeg";
		a.media[3].delivery.url = "http://10.0.0.1/a.mp3";
		a.media.push({ ...a.media[0] });
		a.media.push({ ...a.media[0], ref: "unused.jpg" });
		a.media.push({ ...a.media[1], ref: "naked.png", checksum: undefined });
		delete a.media.at(-1).checksum;
	});

describe("the result", () => {
	test("a messy submission gives each rule it breaks", () => {
		expect([...new Set(ruleIds(validate(pretty(messy()))))].sort()).toEqual([
			"block/blank",
			"delivery/internal-url",
			"delivery/upload-incomplete",
			"delivery/upload-url",
			"format/not-in-submission",
			"format/unknown-property",
			"format/violation",
			"media/duplicate-ref",
			"media/duration-on-image",
			"media/kind-mismatch",
			"media/mime-kind",
			"media/undeclared-ref",
			"media/unused",
			"text/markup",
			"text/newline",
		]);
	});

	test("diagnostics are sorted by position, then rule, pointer and message", () => {
		const { diagnostics } = validate(pretty(messy()));
		expect(diagnostics.length).toBeGreaterThan(15);
		for (let i = 1; i < diagnostics.length; i++) {
			const a = diagnostics[i - 1] as Diagnostic;
			const b = diagnostics[i] as Diagnostic;
			const order =
				(a.range?.offset ?? 0) - (b.range?.offset ?? 0) ||
				(a.range?.endOffset ?? 0) - (b.range?.endOffset ?? 0);
			expect(order).toBeLessThanOrEqual(0);
			if (order === 0) {
				const key = (item: Diagnostic) => [
					item.ruleId,
					item.pointer,
					item.message,
				];
				expect(key(a) <= key(b) || a.ruleId < b.ruleId).toBe(true);
			}
		}
	});

	test("the same input gives the same result", () => {
		const input = pretty(messy());
		expect(validate(input)).toEqual(validate(input));
		expect(JSON.stringify(validate(input))).toBe(
			JSON.stringify(validate(input)),
		);
	});

	test("the order of the input does not change the set of findings", () => {
		const article = messy();
		const reversed = Object.fromEntries(Object.entries(article).reverse());
		const set = (input: string) =>
			validate(input)
				.diagnostics.map(
					(item) => `${item.ruleId} ${item.pointer} ${item.message}`,
				)
				.sort();
		expect(set(pretty(reversed))).toEqual(set(pretty(article)));
	});

	test("the summary counts the diagnostics by severity", () => {
		const inputs = [
			pretty(messy()),
			'{"a": 1, "a": 2, "s": "\\ud800"}',
			"{",
			"[]",
			EXAMPLE_TEXT,
		];
		for (const input of inputs) {
			const result = validate(input);
			const count = (severity: string) =>
				result.diagnostics.filter((item) => item.severity === severity).length;
			expect(result.summary).toEqual({
				errors: count("error"),
				warnings: count("warning"),
			});
			expect(result.ok).toBe(count("error") === 0);
		}
	});

	test("warnings alone keep the submission ok", () => {
		const result = validate(
			pretty(
				variant(example(), (a) => {
					a.hero.captoin = "x";
					a.title = "Kop &amp; staart";
					a.body.push(paragraph(text(" ")));
					a.media.push({
						...a.media[0],
						ref: "unused.jpg",
						mimeType: "video/mp4",
					});
				}),
			),
		);
		expect(result.summary.errors).toBe(0);
		// unknown property, markup, blank block, and an unused declaration of the wrong mime type
		expect(result.summary.warnings).toBe(5);
		expect(result.ok).toBe(true);
	});

	test("one error makes it not ok", () => {
		const result = validate(pretty({ ...example(), title: "" }));
		expect(result.summary).toEqual({ errors: 1, warnings: 0 });
		expect(result.ok).toBe(false);
	});

	test("every rule has a known severity and a summary", () => {
		for (const rule of RULES) {
			expect(["error", "warning"]).toContain(rule.severity);
			expect(rule.summary.length).toBeGreaterThan(0);
		}
	});
});

describe("input that stops the checks", () => {
	test(`input of more than ${MAX_INPUT_LENGTH} characters`, () => {
		const result = validate(" ".repeat(MAX_INPUT_LENGTH + 1));
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toEqual([
			{
				ruleId: "input/too-large",
				severity: "error",
				message: `The input has ${MAX_INPUT_LENGTH + 1} characters; this validator reads at most ${MAX_INPUT_LENGTH}`,
				fix: getRule("input/too-large").fix,
				range: null,
				excerpt: null,
				pointer: null,
			},
		]);
	});

	test(`input of exactly ${MAX_INPUT_LENGTH} characters is read`, () => {
		const input =
			EXAMPLE_TEXT + " ".repeat(MAX_INPUT_LENGTH - EXAMPLE_TEXT.length);
		expect(validate(input).diagnostics).toEqual([]);
	});

	test("a syntax error is the only diagnostic", () => {
		// Duplicates, a lone surrogate and format problems before the error are not reported.
		const input = '{"title": "", "title": "\\ud800", "body": [1,]}';
		expect(ruleIds(validate(input))).toEqual(["json/syntax"]);
	});

	for (const [name, input] of [
		["an array", "[]"],
		["an array of articles", `[${EXAMPLE_TEXT}]`],
		["null", "null"],
		["a string", '"article"'],
		["a number", "42"],
		["true", "true"],
	] as const) {
		test(`a root that is ${name} gives one format violation`, () => {
			const result = validate(input);
			expect(result.diagnostics).toHaveLength(1);
			const [item] = result.diagnostics;
			expect(item?.ruleId).toBe("format/violation");
			expect(item?.pointer).toBe("");
			expect(item?.message).toStartWith("article must be of type object");
			expect(item?.range?.offset).toBe(0);
		});
	}

	test("an empty object gives one violation per missing required field", () => {
		const result = validate("{}");
		expect(result.diagnostics.map((item) => item.message)).toEqual([
			'article is missing required "body"',
			'article is missing required "externalId"',
			'article is missing required "media"',
			'article is missing required "metadata"',
			'article is missing required "title"',
		]);
	});
});

describe("json-level findings next to format findings", () => {
	test("a duplicate key is an error even when the kept value is valid", () => {
		const input = EXAMPLE_TEXT.replace(
			'"title": "Nieuwe',
			'"title": "Oude titel",\n  "title": "Nieuwe',
		);
		const result = validate(input);
		expect(ruleIds(result)).toEqual(["json/duplicate-key"]);
		expect(result.ok).toBe(false);
	});

	test("the last of duplicate keys is the one validated", () => {
		const input = EXAMPLE_TEXT.replace(
			'"title": "Nieuwe',
			'"title": "",\n  "title": "Nieuwe',
		);
		expect(ruleIds(validate(input))).toEqual(["json/duplicate-key"]);
	});

	test("a __proto__ key is an unknown property, nothing more", () => {
		const input = EXAMPLE_TEXT.replace("{", '{"__proto__": {"title": ""},');
		const result = validate(input);
		expect(ruleIds(result)).toEqual(["format/unknown-property"]);
		expect(find(result, "format/unknown-property").pointer).toBe("/__proto__");
	});
});

describe("diagnostic messages and positions", () => {
	test("every repeat of a key points back to the first one", () => {
		const input = pretty(minimal()).replace(
			'"title": "',
			'"title": "a",\n  "title": "b",\n  "title": "',
		);
		const repeats = validate(input).diagnostics.filter(
			(item) => item.ruleId === "json/duplicate-key",
		);
		expect(repeats).toHaveLength(2);
		const firstLine =
			input.split("\n").findIndex((line) => line.includes('"title": "a"')) + 1;
		for (const item of repeats) {
			expect(item.message).toContain(`line ${firstLine}, column 3`);
		}
	});

	test("lines end at \\r, \\r\\n and \\n alike", () => {
		const base = pretty(
			variant(minimal(), (a: Json) => {
				a.body[0].content[0].text = "a <b>b</b>";
			}),
		);
		const lineOf = (input: string) =>
			find(validate(input), "text/markup").range?.line;
		const expected = lineOf(base);
		expect(lineOf(base.replaceAll("\n", "\r\n"))).toBe(expected);
		expect(lineOf(base.replaceAll("\n", "\r"))).toBe(expected);
	});

	test("a block type used as an inline item is called an inline item", () => {
		const input = JSON.stringify(
			variant(minimal(), (a: Json) => {
				a.body[0].content.push({ type: "heading" });
			}),
		);
		const message = find(validate(input), "format/violation").message;
		expect(message).toStartWith("inline item has unknown type");
	});

	test("an invisible character in a syntax error is named by its code point", () => {
		const result = validate('{"a": 1}');
		expect(find(result, "json/syntax").message).toContain("U+00A0");
	});
});
