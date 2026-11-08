/** The built-in rules against the LOX documents in spec/. */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	checkBlankBlocks,
	checkMedia,
	checkSubmissionFields,
	checkText,
	unknownPropertyFinding,
} from "../src/checks.ts";
import {
	escapePointerSegment,
	isObject,
	pointerPath,
} from "../src/json-source.ts";
import {
	BLOCK_TYPES,
	CHECKSUM_ALGORITHMS,
	checkFormat,
	DELIVERY_METHODS,
	DIMENSIONS,
	FORMAT_SCHEMA,
	type FormatIssue,
	type FormatResult,
	INLINE_TYPES,
	LIST_STYLES,
	MARKS,
	MEDIA_KINDS,
	PUBLICATION_STATUSES,
	Reported,
	RIGHTS_DISTRIBUTIONS,
} from "../src/lox-format.ts";
import {
	checkAgainstDocuments,
	compileOpenApi,
	loadDocuments,
	OPENAPI_FILE,
	repairOpenApi,
	SCHEMA_FILE,
	TESTED_OPENAPI_SHA256,
	TESTED_SCHEMA_SHA256,
} from "../src/spec-documents.ts";
import { validate } from "../src/validate.ts";
import {
	DIGESTS,
	EXAMPLE_TEXT,
	example,
	full,
	type Json,
	lineBreak,
	link,
	minimal,
	paragraph,
	sha256,
	SPEC_DIR as specDir,
	text,
	variant,
} from "./fixtures.ts";
import { documentDirectories } from "./synthetic-documents.ts";

const read = (file: string): Json =>
	JSON.parse(readFileSync(join(specDir, file), "utf8"));

/** Every value in `node` with its pointer, depth first. */
function* nodes(node: unknown, pointer = ""): Generator<[string, unknown]> {
	yield [pointer, node];
	if (typeof node !== "object" || node === null) return;
	for (const [key, value] of Object.entries(node)) {
		yield* nodes(value, `${pointer}/${escapePointerSegment(key)}`);
	}
}

/** A copy of `base` with the value at `pointer` replaced, or removed for undefined. */
function replaced(base: Json, pointer: string, value: unknown): Json {
	if (pointer === "") return value;
	return variant(base, (copy) => {
		const segments = pointerPath(pointer);
		const last = segments.pop() as string;
		const owner = segments.reduce((node, segment) => node[segment], copy);
		if (value !== undefined) owner[last] = value;
		else if (Array.isArray(owner)) owner.splice(Number(last), 1);
		else delete owner[last];
	});
}

const TAGS: Record<string, readonly string[]> = {
	type: [...BLOCK_TYPES, ...INLINE_TYPES],
	method: DELIVERY_METHODS,
	algorithm: CHECKSUM_ALGORITHMS,
	kind: MEDIA_KINDS,
	style: LIST_STYLES,
	dimension: DIMENSIONS,
	publicationStatus: PUBLICATION_STATUSES,
	distribution: RIGHTS_DISTRIBUTIONS,
};
const LENGTHS = [0, 2, 8, 21, 51, 201, 501, 1001, 2001];
const STRINGS = [
	"",
	" ",
	" a",
	"a ",
	"a\nb",
	"a/b",
	"..",
	"\u0007",
	"A",
	"nl_NL",
	"HTTP://X.NL",
	"ftp://x.nl",
	"https://x.nl/a b",
	"https://x.nl/{a}",
	"https://x.nl/café",
	"http://",
	"2026-11-07T10:00:00",
	"IMAGE/JPEG",
	"0".repeat(32),
	"0".repeat(64),
	"x".repeat(36),
	"x".repeat(256),
	"x".repeat(1001),
	"😀".repeat(1001),
	"x".repeat(2049),
	"x".repeat(10001),
];
const NUMBERS = [0, -1, 1, 1.5, 2.5, 7, 100001, 31536001, 2 ** 53, 1e300];
const OTHER_TYPES = [null, true, "x", 1, [], {}];

/** Submissions that differ from `base` in one place each, most of them invalid. */
function* variantsOf(base: Json): Generator<Json> {
	for (const [pointer, value] of nodes(base)) {
		const key = pointerPath(pointer).at(-1) ?? "";
		const at = (replacement: unknown) => replaced(base, pointer, replacement);
		if (pointer !== "") yield at(undefined);
		for (const other of OTHER_TYPES) yield at(other);
		if (typeof value === "string") {
			for (const string of STRINGS) yield at(string);
			yield at(value.toUpperCase());
			yield at(`${value} `);
			for (const tag of TAGS[key] ?? []) yield at(tag);
			if (key in TAGS) yield at("other");
		} else if (typeof value === "number") {
			for (const number of NUMBERS) yield at(number);
			yield at(value + 1);
		} else if (Array.isArray(value)) {
			const first = value[0] ?? "x";
			for (const length of LENGTHS) {
				yield at(Array.from({ length }, () => structuredClone(first)));
			}
			if (key === "content" || /^\d+$/.test(key)) {
				yield at(Array.from({ length: 10001 }, lineBreak));
			}
			yield at([...value, "x"]);
		} else if (typeof value === "object" && value !== null) {
			yield at({ ...value, unknownField: 1 });
		}
	}
	for (const [field, values] of Object.entries({
		formatVersion: ["1.0", "2.0", "1.01", 1],
		contentType: ["article", "blog"],
		loxId: ["0b6a4f3e-8f6e-4c1d-9a2b-3c4d5e6f7a8b", "x"],
		extensions: [
			{ a: 1 },
			{ A: 1 },
			[],
			Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`n${i}`, i])),
		],
	})) {
		for (const value of values) yield { ...base, [field]: value };
	}
	if (base.media.length === 0) return;
	for (const sourceIds of [
		[{ system: "s", id: "1" }],
		[{ id: "1" }],
		[{ system: " s", id: "1" }],
		"x",
	]) {
		yield variant(base, (a) => {
			a.media[0].sourceIds = sourceIds;
		});
	}
}

/** Valid submissions that together use every block, inline, delivery, checksum and enum value. */
function validSubmissions(): Json[] {
	const out: Json[] = [example(), full(), minimal()];
	const withBlock = (block: object) =>
		variant(minimal(), (a) => {
			a.body.push(block);
		});
	const declared = (ref: string, kind: string, extra: object = {}) =>
		variant(minimal(), (a) => {
			a.body.push({ type: kind, ref, caption: "c" });
			a.media.push({ ref, kind, mimeType: `${kind}/x-y.z+1`, ...extra });
		});
	for (const block of [
		paragraph(text("a"), lineBreak(), link(), text("b", [...MARKS])),
		{ type: "heading", level: 2, text: "K" },
		{ type: "heading", level: 6, text: "K".repeat(1000) },
		{
			type: "list",
			style: "ordered",
			items: [[lineBreak()], [link([text("a"), text("b")])]],
		},
		{
			type: "list",
			style: "unordered",
			items: Array.from({ length: 1000 }, () => [text()]),
		},
		{ type: "quote", content: [text()] },
		{ type: "quote", content: [link()], attribution: "A" },
		{ type: "embed", url: "http://x.nl" },
		{ type: "embed", url: "https://x.nl/a?b=c#d", provider: "P", title: "T" },
		paragraph(...Array.from({ length: 10000 }, lineBreak)),
		paragraph(link(Array.from({ length: 1000 }, () => text())), lineBreak()),
		paragraph(text("x".repeat(100000))),
	]) {
		out.push(withBlock(block));
	}
	for (const mark of MARKS) out.push(withBlock(paragraph(text("m", [mark]))));
	for (const kind of MEDIA_KINDS) {
		out.push(
			declared(`a.${kind}`, kind, {
				delivery: { method: "url", url: "https://x.nl/a" },
			}),
		);
		for (const algorithm of CHECKSUM_ALGORITHMS) {
			out.push(
				declared(`b.${kind}`, kind, {
					delivery: { method: "upload" },
					byteSize: 9007199254740991,
					checksum: { algorithm, value: DIGESTS[algorithm] },
					width: 100000,
					height: 1,
					durationSeconds: 31536000,
				}),
			);
		}
	}
	for (const [field, values] of [
		["publicationStatus", PUBLICATION_STATUSES],
		[
			"locale",
			["nl", "fy-NL", "zh-Hant-TW", `nl${"-abcdefgh".repeat(3)}-abcde`],
		],
	] as const) {
		for (const value of values)
			out.push(
				variant(minimal(), (a) => {
					a.metadata[field] = value;
				}),
			);
	}
	for (const dimension of DIMENSIONS) {
		out.push(
			variant(minimal(), (a) => {
				a.metadata.classifications = [{ dimension, label: "l", id: "i" }];
			}),
		);
	}
	for (const distribution of RIGHTS_DISTRIBUTIONS) {
		out.push(
			variant(minimal(), (a) => {
				a.metadata.rights = { distribution };
			}),
		);
	}
	out.push(
		variant(minimal(), (a) => {
			a.body = Array.from({ length: 2000 }, () => paragraph());
			a.metadata.authors = Array.from({ length: 50 }, () => ({ name: "n" }));
			a.metadata.classifications = Array.from({ length: 200 }, () => ({
				dimension: "tag",
				label: "t",
			}));
			a.title = "😀".repeat(1000);
			a.summary = "x".repeat(10000);
			a.externalId = "x".repeat(255);
		}),
	);
	out.push(
		variant(minimal(), (a) => {
			a.media = Array.from({ length: 500 }, (_, i) => ({
				ref: `m${i}`,
				kind: "image",
				mimeType: "image/jpeg",
				delivery: { method: "url", url: `https://x.nl/${"x".repeat(2035)}` },
			}));
		}),
	);
	return out;
}

describe("the LOX documents in spec/", () => {
	const documents = () => loadDocuments(specDir);
	const temporary = documentDirectories();
	afterAll(() => temporary.cleanup());

	test("the documents are the tested versions", () => {
		const hash = (file: string) => sha256(readFileSync(join(specDir, file)));
		expect(hash(SCHEMA_FILE)).toBe(TESTED_SCHEMA_SHA256);
		expect(hash(OPENAPI_FILE)).toBe(TESTED_OPENAPI_SHA256);
		expect(documents().specCheck.matchesTested).toBe(true);
	});

	test("the example passes both documents and gives no diagnostics at all", () => {
		const { checkSchema, checkOpenApi } = documents();
		expect(checkSchema(example())).toEqual([]);
		expect(checkOpenApi(example())).toEqual([]);
		const result = validate(EXAMPLE_TEXT, { specDir });
		expect(result.diagnostics).toEqual([]);
		expect(result.specCheck?.matchesTested).toBe(true);
	});

	test("without repair the OpenAPI document rejects the valid example", () => {
		expect(compileOpenApi(read(OPENAPI_FILE))(example())).not.toEqual([]);
	});

	const valid = validSubmissions();

	describe("what the built-in rules accept, both documents accept", () => {
		test("the valid set is broad and valid by the built-in rules", () => {
			expect(valid.length).toBeGreaterThan(50);
			for (const article of valid)
				expect(checkFormat(article).issues).toEqual([]);
		});

		test("the repaired OpenAPI document and the schema accept every one", () => {
			const { checkSchema, checkOpenApi } = documents();
			const rejected = valid.flatMap((article, index) =>
				[...checkSchema(article), ...checkOpenApi(article)].map(
					(issue) => `${index}: ${issue.pointer} ${issue.message}`,
				),
			);
			expect(rejected).toEqual([]);
		});
	});

	describe("the built-in rules are at least as strict as both documents", () => {
		interface Checked {
			article: Json;
			builtIn: FormatIssue[];
			format: FormatResult;
			schema: FormatIssue[];
			openapi: FormatIssue[];
		}

		/**
		 * Each distinct variant with its issues, checked once: the variants run to tens of
		 * thousands and every check is pure. Built on first use: describe callbacks run even when
		 * the tests skip.
		 */
		let cache: Checked[] | undefined;
		const variants = (): Checked[] => {
			if (cache !== undefined) return cache;
			const { checkSchema, checkOpenApi } = documents();
			const seen = new Set<string>();
			cache = [];
			for (const base of [
				full(),
				example(),
				...valid
					.slice(3)
					.filter((article) => JSON.stringify(article).length < 2000),
			]) {
				for (const article of variantsOf(base)) {
					const key = sha256(JSON.stringify(article));
					if (seen.has(key)) continue;
					seen.add(key);
					const format = checkFormat(article);
					cache.push({
						article,
						builtIn: format.issues,
						format,
						schema: checkSchema(article),
						openapi: checkOpenApi(article),
					});
				}
			}
			return cache;
		};
		const invalid = () =>
			variants().filter(({ builtIn }) => builtIn.length > 0);

		/** Each document issue without a built-in issue at the same pointer. */
		const looser = (issuesOf: (variant: Checked) => FormatIssue[]) => {
			const misses = new Map<string, number>();
			for (const checked of variants()) {
				const builtIn = new Set(checked.builtIn.map((issue) => issue.pointer));
				for (const issue of issuesOf(checked)) {
					if (builtIn.has(issue.pointer)) continue;
					const key = `${issue.pointer.replace(/\/\d+/g, "/#")} ${issue.keyword}: ${issue.message}`;
					misses.set(key, (misses.get(key) ?? 0) + 1);
				}
			}
			return [...misses.keys()];
		};

		test("enough variants are generated, most of them invalid", () => {
			expect(variants().length).toBeGreaterThan(3000);
			expect(invalid().length / variants().length).toBeGreaterThan(0.7);
		});

		test("against the schema", () => {
			expect(looser(({ schema }) => schema)).toEqual([]);
		});

		test("against the repaired OpenAPI document", () => {
			expect(looser(({ openapi }) => openapi)).toEqual([]);
		});

		test("the documents reject the variants too, so the comparison is not empty", () => {
			const rejectedBy = (issuesOf: (variant: Checked) => FormatIssue[]) =>
				invalid().filter((checked) => issuesOf(checked).length > 0).length /
				invalid().length;
			expect(rejectedBy(({ schema }) => schema)).toBeGreaterThan(0.8);
			expect(rejectedBy(({ openapi }) => openapi)).toBeGreaterThan(0.8);
		});

		test("the comparison notices documents stricter than the built-in rules", () => {
			const schema = read(SCHEMA_FILE);
			schema.$defs.shortText.maxLength = 35;
			const openapi = read(OPENAPI_FILE);
			openapi.components.schemas.MediaDeclarationDto.properties.width.maximum = 99999;
			const stricter = loadDocuments(temporary.write(schema, openapi));
			expect(looser(({ article }) => stricter.checkSchema(article))).toContain(
				"/title maxLength: title is 36 characters; the maximum is 35",
			);
			expect(looser(({ article }) => stricter.checkOpenApi(article))).toContain(
				"/media/#/width maximum: media declaration width is 100000; the maximum is 99999",
			);
		});

		test("a variant the built-in rules accept, both documents accept", () => {
			const rejected = variants()
				.filter(({ builtIn }) => builtIn.length === 0)
				.flatMap(({ schema, openapi }) =>
					[...schema, ...openapi].map(
						(issue) => `${issue.pointer} ${issue.message}`,
					),
				);
			expect(rejected).toEqual([]);
		});

		test("no variant gives a spec/violation", () => {
			// What validate() does with the documents, on the issues already at hand.
			const reported = variants().flatMap(
				({ article, builtIn, schema, openapi }) => {
					const said = new Reported();
					said.add(builtIn);
					return checkAgainstDocuments(
						article,
						{ checkSchema: () => schema, checkOpenApi: () => openapi },
						said,
					).map((issue) => `${issue.pointer} ${issue.message}`);
				},
			);
			expect([...new Set(reported)]).toEqual([]);
		});

		test("the checks beyond the format take every variant", () => {
			// validate() runs them on every object it parses; the end-to-end sample below sees few.
			let findings = 0;
			for (const { article, format } of variants()) {
				if (!isObject(article)) continue;
				findings +=
					checkSubmissionFields(article).length +
					checkMedia(article).length +
					checkText(format.text).length +
					checkBlankBlocks(article).length +
					format.unknown.map(unknownPropertyFinding).length;
			}
			expect(findings).toBeGreaterThan(0);
		});

		test("end to end, a sample of the variants gives no spec/violation or spec/changed", () => {
			const sample = variants().filter((_, index) => index % 50 === 0);
			expect(sample.length).toBeGreaterThan(100);
			const reported = new Set<string>();
			for (const { article } of sample) {
				for (const item of validate(JSON.stringify(article), { specDir })
					.diagnostics) {
					if (item.ruleId.startsWith("spec/"))
						reported.add(`${item.ruleId} ${item.pointer} ${item.message}`);
				}
			}
			expect([...reported]).toEqual([]);
		});
	});

	describe("changed documents", () => {
		const copy = (change: (schema: Json, openapi: Json) => void) => {
			const schema = read(SCHEMA_FILE);
			const openapi = read(OPENAPI_FILE);
			change(schema, openapi);
			return temporary.write(schema, openapi);
		};

		test("a reformatted copy is reported as changed but checks the same", () => {
			const dir = copy(() => {});
			const result = validate(EXAMPLE_TEXT, { specDir: dir });
			expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
				"spec/changed",
			]);
			expect(result.specCheck?.matchesTested).toBe(false);
			expect(result.ok).toBe(true);
		});

		test("one changed document is enough to be changed", () => {
			const dir = temporary.write(
				readFileSync(join(specDir, SCHEMA_FILE), "utf8"),
				`${readFileSync(join(specDir, OPENAPI_FILE), "utf8")}\n`,
				true,
			);
			expect(loadDocuments(dir).specCheck).toMatchObject({
				schemaSha256: TESTED_SCHEMA_SHA256,
				matchesTested: false,
			});
		});

		test("a stricter limit in the schema is a spec/violation", () => {
			const dir = copy((schema) => {
				schema.$defs.shortText.maxLength = 20;
			});
			const result = validate(
				JSON.stringify({ ...example(), title: "x".repeat(21) }),
				{
					specDir: dir,
				},
			);
			expect(
				result.diagnostics.filter((item) => item.ruleId === "spec/violation"),
			).toContainEqual(
				expect.objectContaining({
					pointer: "/title",
					message: "title is 21 characters; the maximum is 20",
				}),
			);
			expect(result.ok).toBe(false);
		});

		test("a stricter limit in the OpenAPI document is a spec/violation, even next to a built-in one", () => {
			const dir = copy((_schema, openapi) => {
				openapi.components.schemas.ArticleSubmission.properties.title.maxLength = 20;
			});
			const result = validate(
				JSON.stringify({ ...example(), title: "x".repeat(1001) }),
				{
					specDir: dir,
				},
			);
			expect(
				result.diagnostics
					.filter((item) => item.pointer === "/title")
					.map((item) => `${item.ruleId}: ${item.message}`),
			).toEqual([
				"format/violation: title is 1001 characters; the maximum is 1000",
				"spec/violation: title is 1001 characters; the maximum is 20",
			]);
		});

		test("a new required field is a spec/violation", () => {
			const dir = copy((_schema, openapi) => {
				openapi.components.schemas.EmbedBlockDto.required.push("provider");
			});
			const article = variant(minimal(), (a) => {
				a.body.push({ type: "embed", url: "https://x.nl" });
			});
			expect(
				validate(JSON.stringify(article), { specDir: dir }).diagnostics.map(
					(item) => [item.ruleId, item.pointer],
				),
			).toEqual([
				["spec/violation", "/body/1"],
				["spec/changed", null],
			]);
		});

		test("a new block DTO without a known tag stops the check", () => {
			const dir = copy((_schema, openapi) => {
				const { schemas } = openapi.components;
				schemas.TableBlockDto = structuredClone(schemas.EmbedBlockDto);
				schemas.ArticleSubmission.properties.body.items.oneOf.push({
					$ref: "#/components/schemas/TableBlockDto",
				});
			});
			expect(() => validate(EXAMPLE_TEXT, { specDir: dir })).toThrow(
				/TableBlockDto/,
			);
		});
	});

	describe("the built-in rules equal the strictest reading of both documents", () => {
		const COMPARED = [
			"type",
			"const",
			"enum",
			"format",
			"pattern",
			"minLength",
			"maxLength",
			"minimum",
			"maximum",
			"minItems",
			"maxItems",
			"maxProperties",
			"uniqueItems",
			"required",
		];
		const KNOWN = new Set([
			...COMPARED,
			"title",
			"description",
			"example",
			"$comment",
			"$schema",
			"$defs",
			"$ref",
			"allOf",
			"properties",
			"propertyNames",
			"items",
			"oneOf",
			"discriminator",
			// The built-in schema's annotation for text checks; it constrains nothing.
			"textField",
		]);

		const resolveRef = (root: Json, reference: string): Json => {
			let node = root;
			for (const segment of reference.slice(2).split("/"))
				node = node?.[segment];
			if (node === undefined)
				throw new Error(`dangling reference ${reference}`);
			return node;
		};

		function flatten(
			schema: Json,
			root: Json,
			path: string,
			out: Map<string, unknown>,
		) {
			for (const key of Object.keys(schema)) {
				// A keyword this walk does not know could be a constraint the built-in rules miss.
				if (!KNOWN.has(key))
					throw new Error(`unknown keyword ${key} at ${path}`);
			}
			if (schema.$ref) flatten(resolveRef(root, schema.$ref), root, path, out);
			for (const part of schema.allOf ?? []) flatten(part, root, path, out);
			for (const keyword of COMPARED) {
				if (!(keyword in schema)) continue;
				let value = schema[keyword];
				if (keyword === "enum" || keyword === "required")
					value = [...value].sort();
				if (keyword === "pattern") value = value.replaceAll("\\/", "/");
				out.set(`${path} ${keyword}`, value);
			}
			for (const [name, property] of Object.entries(schema.properties ?? {})) {
				flatten(property, root, `${path}.${name}`, out);
			}
			if (schema.propertyNames)
				flatten(schema.propertyNames, root, `${path}{}`, out);
			if (schema.items) flatten(schema.items, root, `${path}[]`, out);
			if (schema.oneOf) {
				const tag = schema.discriminator?.propertyName;
				if (!tag) throw new Error(`oneOf without a discriminator at ${path}`);
				for (const arm of schema.oneOf) {
					const resolved = arm.$ref ? resolveRef(root, arm.$ref) : arm;
					flatten(arm, root, `${path}<${resolved.properties[tag].const}>`, out);
				}
			}
			return out;
		}

		const flatSchema = () =>
			flatten(read(SCHEMA_FILE), read(SCHEMA_FILE), "$", new Map());
		const flatOpenApi = () => {
			const document = repairOpenApi(read(OPENAPI_FILE)) as Json;
			return flatten(
				document.components.schemas.ArticleSubmission,
				document,
				"$",
				new Map(),
			);
		};
		const flatBuiltIn = () =>
			flatten(FORMAT_SCHEMA, FORMAT_SCHEMA, "$", new Map());

		const strictest = (keyword: string, a: unknown, b: unknown) => {
			if (keyword === "required")
				return [...new Set([...(a as string[]), ...(b as string[])])].sort();
			if (JSON.stringify(a) === JSON.stringify(b)) return a;
			const numbers = [a, b] as number[];
			if (keyword.startsWith("max")) return Math.min(...numbers);
			if (keyword.startsWith("min")) return Math.max(...numbers);
			if (
				keyword === "type" &&
				[a, b].includes("integer") &&
				[a, b].includes("number")
			)
				return "integer";
			return undefined;
		};

		/** Where the built-in rules differ from the strictest reading on purpose. */
		const ON_PURPOSE: Record<string, unknown> = {
			// LOX sets these two on submission; the schema requires them of the stored article.
			"$ required": ["body", "externalId", "media", "metadata", "title"],
		};
		/** Rules only the built-in schema has: the documents' prose asks for them, their keywords do not. */
		const ONLY_BUILT_IN = new Set(
			["createdAt", "publishedAt", "updatedAt"].map(
				// "RFC 3339 date-time with an explicit offset": the date-time format alone allows +01.
				(field) => `$.metadata.timestamps.${field} pattern`,
			),
		);

		const drift = () => {
			const schema = flatSchema();
			const merged = new Map(schema);
			const problems: string[] = [];
			for (const [key, value] of flatOpenApi()) {
				const keyword = key.split(" ")[1] ?? "";
				const choice = schema.has(key)
					? strictest(keyword, schema.get(key), value)
					: value;
				if (choice === undefined)
					problems.push(`conflict between the documents: ${key}`);
				else merged.set(key, choice);
			}
			const built = flatBuiltIn();
			for (const [key, value] of merged) {
				const expected = key in ON_PURPOSE ? ON_PURPOSE[key] : value;
				if (!built.has(key)) problems.push(`missing from built-in: ${key}`);
				else if (JSON.stringify(built.get(key)) !== JSON.stringify(expected))
					problems.push(
						`differs: ${key} is ${JSON.stringify(built.get(key))}, expected ${JSON.stringify(expected)}`,
					);
			}
			for (const key of built.keys()) {
				if (!merged.has(key) && !ONLY_BUILT_IN.has(key))
					problems.push(`only in built-in: ${key}`);
			}
			return problems;
		};

		test("every bound, pattern, enum, format, required field and numeric type", () => {
			expect(drift()).toEqual([]);
		});

		test("the comparison covers a substantial rule set", () => {
			const built = flatBuiltIn();
			expect(built.size).toBeGreaterThan(250);
			const keywords = new Set(
				[...built.keys()].map((key) => key.split(" ")[1]),
			);
			for (const keyword of COMPARED) expect(keywords).toContain(keyword);
		});

		test("the schema requires formatVersion and contentType, which LOX sets", () => {
			expect(flatSchema().get("$ required")).toEqual(
				expect.arrayContaining(["contentType", "formatVersion"]),
			);
		});

		test("the documents differ from each other only where known", () => {
			const schema = flatSchema();
			const openapi = flatOpenApi();
			const known = [
				/^\$ required$/,
				/^\$\.(formatVersion|contentType|loxId|extensions)( |\{\})/,
				/^\$\.body\[\]<list>\.items\[\] (minItems|maxItems)$/,
				/^\$\.body\[\]<heading>\.level type$/,
				/^\$\.media\[\]\.(width|height|durationSeconds|byteSize) type$/,
				/^\$\.media\[\]\.sourceIds/,
				/^\$\.media\[\]\.delivery/,
				/^\$\.media\[\] required$/,
			];
			const keys = new Set([...schema.keys(), ...openapi.keys()]);
			const differences = [...keys].filter(
				(key) =>
					JSON.stringify(schema.get(key)) !== JSON.stringify(openapi.get(key)),
			);
			expect(
				differences.filter(
					(key) => !known.some((pattern) => pattern.test(key)),
				),
			).toEqual([]);
			for (const pattern of known) {
				expect({
					pattern: String(pattern),
					found: differences.some((key) => pattern.test(key)),
				}).toEqual({
					pattern: String(pattern),
					found: true,
				});
			}
		});
	});
});
