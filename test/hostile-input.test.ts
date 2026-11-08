/**
 * Input built to be slow or to crash: every case must finish within its time bound and give a
 * diagnostic, never an exception. The bounds are generous, about ten times a normal run, so that
 * only a change in complexity, such as quadratic work or regex backtracking, makes them fail.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { checkText } from "../src/checks.ts";
import { MAX_DEPTH, parseJson } from "../src/json-source.ts";
import { checkFormat } from "../src/lox-format.ts";
import { MAX_INPUT_LENGTH, validate } from "../src/validate.ts";
import {
	elapsed,
	full,
	type Json,
	minimal,
	paragraph,
	text,
	variant,
} from "./fixtures.ts";
import {
	documentDirectories,
	openApiDocument,
	schemaDocument,
} from "./synthetic-documents.ts";

const BOUND = 3000;
const MB = 1024 * 1024;

const finishes = (input: string, bound = BOUND) => {
	let result: ReturnType<typeof validate> | undefined;
	const time = elapsed(() => {
		result = validate(input);
	});
	expect(time).toBeLessThan(bound);
	return result as ReturnType<typeof validate>;
};

describe("size", () => {
	test("a 2-million-item array", () => {
		const result = finishes(`[${Array(2_000_000).fill("0").join(",")}]`);
		expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
			"format/violation",
		]);
	});

	test("a body of 200,000 blank paragraphs", () => {
		const article = {
			...minimal(),
			body: Array.from({ length: 200_000 }, () => paragraph(text(" "))),
		};
		const result = finishes(JSON.stringify(article), 6000);
		// One format violation for the length, one block/blank per paragraph.
		expect(result.summary.errors).toBe(1);
		expect(result.summary.warnings).toBe(200_000);
	});

	test("50,000 media declarations with problems", () => {
		const article = {
			...minimal(),
			media: Array.from({ length: 50_000 }, (_, i) => ({
				ref: `m${i % 1000}`,
				kind: "image",
				mimeType: "video/mp4",
				delivery: { method: "upload", url: "http://10.0.0.1/" },
			})),
		};
		const result = finishes(JSON.stringify(article), 6000);
		expect(result.diagnostics.length).toBeGreaterThan(150_000);
	});

	test("a 15-million-character string", () => {
		const result = finishes(
			JSON.stringify({ ...minimal(), title: "x".repeat(15_000_000) }),
		);
		expect(result.diagnostics.map((item) => item.message)).toEqual([
			"title is 15000000 characters; the maximum is 1000",
		]);
	});

	test("a string of 2 million escapes, half of them lone surrogates", () => {
		const result = finishes(`{"title": "${"\\n\\ud800".repeat(1_000_000)}"}`);
		expect(
			result.diagnostics.some((item) => item.ruleId === "json/invalid-string"),
		).toBe(true);
	});

	test("input just over the limit is refused without being read", () => {
		const input = " ".repeat(MAX_INPUT_LENGTH + 1);
		expect(elapsed(() => validate(input))).toBeLessThan(100);
	});

	test("input at the limit is read", () => {
		const input = `${" ".repeat(MAX_INPUT_LENGTH - 2)}{}`;
		expect(finishes(input).diagnostics[0]?.ruleId).toBe("format/violation");
	});
});

describe("nesting", () => {
	for (const [name, input] of [
		["15 million open brackets", "[".repeat(15 * MB)],
		["a million open objects", '{"a":'.repeat(1_000_000)],
		[
			"deep nesting that closes",
			`${"[".repeat(100_000)}${"]".repeat(100_000)}`,
		],
		["alternating arrays and objects", '[{"a":'.repeat(200_000)],
	] as const) {
		test(`${name} gives a syntax diagnostic, not a stack overflow`, () => {
			const result = finishes(input);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.message).toContain(
				`nested deeper than ${MAX_DEPTH} levels`,
			);
		});
	}

	test("nesting at the limit inside extensions is validated without trouble", () => {
		const depth = MAX_DEPTH - 2;
		const deep = `${"[".repeat(depth)}${"]".repeat(depth)}`;
		const input = JSON.stringify({
			...minimal(),
			extensions: { x: "DEEP" },
		}).replace('"DEEP"', deep);
		expect(finishes(input).diagnostics.map((item) => item.ruleId)).toEqual([
			"format/not-in-submission",
		]);
	});

	test("deeply nested links and rich text are rejected without recursion trouble", () => {
		let inline: Json = text();
		for (let level = 0; level < MAX_DEPTH / 3; level++) {
			inline = { type: "link", href: "https://x.nl", children: [inline] };
		}
		const article = { ...minimal(), body: [paragraph(inline)] };
		expect(finishes(JSON.stringify(article)).ok).toBe(false);
	});
});

describe("keys", () => {
	test("200,000 duplicate keys", () => {
		const input = `{${Array.from({ length: 200_000 }, () => '"a":1').join(",")}}`;
		const result = finishes(input);
		expect(
			result.diagnostics.filter((item) => item.ruleId === "json/duplicate-key"),
		).toHaveLength(199_999);
	});

	test("100,000 unknown properties close to known names", () => {
		const article = {
			...minimal(),
			...Object.fromEntries(
				Array.from({ length: 100_000 }, (_, i) => [`titl${i}`, 1]),
			),
		};
		expect(finishes(JSON.stringify(article)).summary.warnings).toBe(100_000);
	});

	test("a property name of a million characters", () => {
		const article = { ...minimal(), ["t".repeat(1_000_000)]: 1 };
		expect(finishes(JSON.stringify(article)).summary.warnings).toBe(1);
	});

	test("51 to 100,000 extension names", () => {
		const extensions = Object.fromEntries(
			Array.from({ length: 100_000 }, (_, i) => [i % 2 ? `n${i}` : `N${i}`, i]),
		);
		const result = finishes(JSON.stringify({ ...minimal(), extensions }));
		expect(result.ok).toBe(false);
	});
});

describe("regular expressions", () => {
	// Long enough that quadratic work, about N² = 4·10¹⁰ steps, runs far past the bound, while a
	// linear pass over every field takes about a tenth of it.
	const N = 200_000;
	const strings: Record<string, string> = {
		spaces: " ".repeat(N),
		letters: "a".repeat(N),
		"letter, spaces, letter": `a${" ".repeat(N)}!`,
		"no-break spaces": " ".repeat(N),
		dots: ".".repeat(N),
		"trailing whitespace": `${"a".repeat(N)} `,
		"scheme and junk": `http://${"a".repeat(N)} `,
		colons: `http://${":".repeat(N)} `,
		"at signs": `http://${"@".repeat(N)}%`,
		percents: `http://x/${"%".repeat(N)}`,
		"percent pairs": `http://x/?${"%2".repeat(N / 2)}`,
		"open IPv6": `http://[${":".repeat(N)}`,
		labels: `http://${"a.".repeat(N / 2)}-`,
		"locale subtags": `nl${"-a".repeat(N / 2)}!`,
		"mime subtype": `a/${"a".repeat(N)}A`,
		"date-time digits": `2026-11-07T10:00:00${"0".repeat(N)}`,
		"hex then junk": `${"a".repeat(N)}g`,
		"control at the end": `${"a".repeat(N)}\u0000`,
	};

	for (const [name, value] of Object.entries(strings)) {
		test(`${name} in every patterned and formatted field`, () => {
			const article = variant(full(), (a) => {
				a.externalId = value;
				a.hero.ref = value;
				a.metadata.locale = value;
				a.metadata.canonicalUrl = value;
				a.metadata.timestamps.updatedAt = value;
				a.metadata.authors[0].sourceId = value;
				a.metadata.rights.licence.url = value;
				a.body[9].url = value;
				a.body[0].content[3].href = value;
				a.media[0].ref = value;
				a.media[0].mimeType = value;
				a.media[0].delivery.url = value;
				a.media[3].checksum.value = value;
				a.formatVersion = value;
				a.loxId = value;
				a.extensions = { [value]: 1 };
			});
			let result: ReturnType<typeof checkFormat> | undefined;
			const time = elapsed(() => {
				result = checkFormat(article);
			});
			expect(time).toBeLessThan(BOUND);
			// The value reached the patterns and formats instead of being dropped on the way.
			expect(result?.issues.length).toBeGreaterThan(0);
		});
	}

	const markup: Record<string, string> = {
		"an open tag that never closes": `<a${" ".repeat(N)}`,
		"many open tags": "<a ".repeat(N / 3),
		"a tag name that never ends": `<${"a".repeat(N)}`,
		"hyphens in a tag name": `<a${"-".repeat(N)}<`,
		"tags inside attributes": `<a ${"x=<".repeat(N / 3)}`,
		slashes: `<a${"/".repeat(N)}`,
		"an entity that never ends": `&${"a".repeat(N)}`,
		"many ampersands": "&".repeat(N),
		"numeric entity starts": "&#".repeat(N / 2),
		"hex entity starts": "&#x".repeat(N / 3),
		"less-than signs": "<".repeat(N),
		"line breaks": "\r".repeat(N),
	};
	for (const [name, value] of Object.entries(markup)) {
		test(`text/markup and text/newline on ${name}`, () => {
			const article = variant(full(), (a) => {
				a.title = value;
				a.summary = value;
				a.body[0].content[0].text = value;
				a.body[1].text = value;
				a.media[0].description = value;
			});
			const { text } = checkFormat(article);
			// The hostile value must reach the text checks, or this times nothing.
			expect(text.filter((field) => field.text === value)).toHaveLength(5);
			expect(elapsed(() => checkText(text))).toBeLessThan(BOUND);
		});
	}

	test("blank detection on a long run of invisible characters", () => {
		const article = { ...minimal(), body: [paragraph(text("​  ".repeat(N)))] };
		expect(
			finishes(JSON.stringify(article)).diagnostics.map((item) => item.ruleId),
		).toContain("block/blank");
	});

	test("the parser on a long number and a long run of whitespace", () => {
		expect(elapsed(() => parseJson(`${"1".repeat(5 * MB)}`))).toBeLessThan(
			BOUND,
		);
		expect(elapsed(() => parseJson(`${" ".repeat(5 * MB)}1`))).toBeLessThan(
			BOUND,
		);
		expect(elapsed(() => parseJson(`-${"0".repeat(5 * MB)}`))).toBeLessThan(
			BOUND,
		);
	});
});

describe("with --spec-dir", () => {
	const directories = documentDirectories();
	afterAll(() => directories.cleanup());

	// Every document issue that the built-in rules did not report word for word is compared with
	// the values they rejected as a whole. A pairwise comparison would grow with the product of
	// both, about 6 s instead of 0.3 s for these 16,000 blocks.
	test("many values rejected by type and by a document limit stay linear", () => {
		const openapi = openApiDocument();
		const heading =
			openapi.components.schemas.ArticleSubmission.properties.body.items.oneOf.find(
				(arm: Json) => arm.properties.type.const === "heading",
			);
		heading.properties.level.type = "number";
		const specDir = directories.write(schemaDocument(), openapi);
		const article = {
			...minimal(),
			body: Array.from({ length: 16_000 }, () => ({
				type: "heading",
				level: 1.5,
				text: "K",
			})),
		};
		const input = JSON.stringify(article);
		validate(input, { specDir });
		const without = elapsed(() => validate(input));
		const withDocuments = elapsed(() => validate(input, { specDir }));
		expect(withDocuments).toBeLessThan(Math.max(1000, without * 5));
	});
});
