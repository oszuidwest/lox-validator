/**
 * The check against the LOX documents, with synthetic documents that each test changes as it needs.
 * spec-conformance.test.ts checks against the documents in spec/.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRule } from "../src/rules.ts";
import {
	checkAgainstDocuments,
	compileOpenApi,
	isTestedVersion,
	loadDocuments,
	OPENAPI_FILE,
	repairOpenApi,
	SCHEMA_FILE,
	SpecDocumentsError,
	TESTED_OPENAPI_SHA256,
	TESTED_SCHEMA_SHA256,
} from "../src/spec-documents.ts";
import type { ValidationResult } from "../src/types.ts";
import { validate } from "../src/validate.ts";
import {
	EXAMPLE_TEXT,
	example,
	full,
	type Json,
	paragraph,
	pretty,
	sha256,
	text,
	variant,
} from "./fixtures.ts";
import {
	documentDirectories,
	openApiDocument,
	schemaDocument,
} from "./synthetic-documents.ts";

const directories = documentDirectories();
afterAll(() => directories.cleanup());
const write = directories.write;
const spec = (result: ValidationResult) =>
	result.diagnostics
		.filter((item) => item.ruleId.startsWith("spec/"))
		.map((item) => [item.ruleId, item.pointer, item.message]);

/** Documents equal to the built-in rules, apart from `change`. */
const documents = (
	change: (schema: Json, openapi: Json) => void = () => {},
) => {
	const schema = schemaDocument();
	const openapi = openApiDocument();
	change(schema, openapi);
	return write(schema, openapi);
};
const submission = (openapi: Json) =>
	openapi.components.schemas.ArticleSubmission;
const headingArm = (owner: Json) =>
	owner.properties.body.items.oneOf.find(
		(arm: Json) => arm.properties.type.const === "heading",
	);

describe("documents that equal the built-in rules", () => {
	const dir = documents();

	test("compile, and give no issues for valid submissions", () => {
		const loaded = loadDocuments(dir);
		for (const article of [example(), full()]) {
			expect(loaded.checkSchema(article)).toEqual([]);
			expect(loaded.checkOpenApi(article)).toEqual([]);
			expect(checkAgainstDocuments(article, loaded)).toEqual([]);
		}
	});

	test("hash each document under its own name and are not the tested versions", () => {
		const { specCheck } = loadDocuments(dir);
		expect(specCheck).toEqual({
			dir,
			schemaSha256: sha256(readFileSync(join(dir, SCHEMA_FILE), "utf8")),
			openapiSha256: sha256(readFileSync(join(dir, OPENAPI_FILE), "utf8")),
			matchesTested: false,
		});
	});

	test("give spec/changed as the only diagnostic, which keeps the submission ok", () => {
		const result = validate(EXAMPLE_TEXT, { specDir: dir });
		expect(result.diagnostics).toEqual([
			{
				ruleId: "spec/changed",
				severity: "warning",
				message: `The LOX documents in ${dir} differ from the versions this validator was tested with`,
				fix: getRule("spec/changed").fix,
				range: null,
				excerpt: null,
				pointer: null,
			},
		]);
		expect(result.ok).toBe(true);
		expect(result.specCheck?.matchesTested).toBe(false);
	});

	test("spec/changed sorts after every located diagnostic", () => {
		const result = validate(pretty({ ...example(), title: "" }), {
			specDir: dir,
		});
		expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
			"format/violation",
			"spec/changed",
		]);
	});

	test("repeat no problem the built-in rules already report", () => {
		const broken = [
			pretty({ ...example(), title: "" }),
			pretty(
				variant(example(), (a) => {
					a.body[0] = { type: "table" };
				}),
			),
			pretty(
				variant(example(), (a) => {
					a.body[1].level = 1.5;
				}),
			),
			pretty(
				variant(example(), (a) => {
					delete a.metadata;
				}),
			),
			pretty(
				variant(full(), (a) => {
					a.media[1].checksum.value = "AB";
				}),
			),
			"[]",
			"null",
		];
		for (const input of broken) {
			const result = validate(input, { specDir: dir });
			expect(spec(result)).toEqual([
				["spec/changed", null, expect.any(String)],
			]);
		}
	});

	test("a problem both documents report comes back once", () => {
		const issues = checkAgainstDocuments(
			{ ...example(), title: "" },
			loadDocuments(dir),
		);
		expect(issues).toEqual([
			{
				pointer: "/title",
				keyword: "minLength",
				message: "title is empty; it needs at least 1 character",
			},
		]);
	});

	test("the schema check fills in formatVersion and contentType, as LOX sets them", () => {
		const schema = schemaDocument();
		schema.required.push("formatVersion", "contentType");
		const loaded = loadDocuments(write(schema, openApiDocument()));
		expect(loaded.checkSchema(example())).toEqual([]);
		// A value the submission gives itself is checked as given.
		expect(
			loaded.checkSchema({ ...example(), contentType: "blog" }),
		).toHaveLength(1);
	});
});

describe("documents stricter than the built-in rules", () => {
	const shorterTitles = documents((schema) => {
		schema.$defs.shortText.maxLength = 10;
	});

	test("a stricter limit is a spec/violation at the value", () => {
		const input = pretty({ ...example(), title: "x".repeat(11) });
		const result = validate(input, { specDir: shorterTitles });
		const violation = result.diagnostics.find(
			(item) => item.ruleId === "spec/violation",
		);
		expect(violation).toMatchObject({
			severity: "error",
			pointer: "/title",
			message: "title is 11 characters; the maximum is 10",
			excerpt: `"${"x".repeat(11)}"`,
		});
		expect(result.ok).toBe(false);
	});

	test("a stricter limit is not hidden by the built-in limit on the same value", () => {
		const input = pretty({ ...example(), title: "x".repeat(1001) });
		const result = validate(input, { specDir: shorterTitles });
		expect(
			result.diagnostics
				.filter((item) => item.pointer === "/title")
				.map((item) => [item.ruleId, item.message]),
		).toEqual([
			["format/violation", "title is 1001 characters; the maximum is 1000"],
			["spec/violation", "title is 1001 characters; the maximum is 10"],
		]);
	});

	test("a stricter limit in an element with another built-in problem is reported", () => {
		const input = pretty(
			variant(example(), (a) => {
				a.body[1] = { type: "heading", level: 9, text: "x".repeat(11) };
			}),
		);
		const result = validate(input, { specDir: shorterTitles });
		expect(spec(result)).toContainEqual([
			"spec/violation",
			"/body/1/text",
			"heading text is 11 characters; the maximum is 10",
		]);
	});

	test("only the rejected element is silenced, not one whose index starts the same", () => {
		const article = variant(example(), (a) => {
			a.body = Array.from({ length: 11 }, () => paragraph());
			a.body[1] = { type: "table", text: "x".repeat(11) };
			a.body[10] = { type: "heading", level: 2, text: "x".repeat(11) };
		});
		const result = validate(pretty(article), { specDir: shorterTitles });
		expect(
			spec(result).filter(
				([ruleId, pointer]) =>
					ruleId === "spec/violation" && String(pointer).startsWith("/body"),
			),
		).toEqual([
			[
				"spec/violation",
				"/body/10/text",
				"heading text is 11 characters; the maximum is 10",
			],
		]);
	});

	test("a value the built-in rules reject by its type needs no second word", () => {
		const dir = documents((_schema, openapi) => {
			headingArm(submission(openapi)).properties.level.type = "number";
		});
		const input = pretty(
			variant(example(), (a) => {
				a.body[1].level = 1.5;
			}),
		);
		const loaded = loadDocuments(dir);
		// The OpenAPI stand-in accepts 1.5 as a number and rejects it by its minimum.
		expect(loaded.checkOpenApi(JSON.parse(input))).toEqual([
			expect.objectContaining({ pointer: "/body/1/level", keyword: "minimum" }),
		]);
		expect(spec(validate(input, { specDir: dir }))).toEqual([
			["spec/changed", null, expect.any(String)],
		]);
	});

	test("a rule only the OpenAPI document has is reported", () => {
		const dir = documents((_schema, openapi) => {
			submission(openapi).required.push("summary");
		});
		const input = pretty(
			variant(example(), (a) => {
				delete a.summary;
			}),
		);
		expect(spec(validate(input, { specDir: dir }))).toContainEqual([
			"spec/violation",
			"",
			'article is missing required "summary"',
		]);
	});

	test("a rule only the schema has is reported", () => {
		const dir = documents((schema) => {
			schema.required.push("hero");
		});
		const input = pretty(
			variant(example(), (a) => {
				delete a.hero;
				a.media = [];
			}),
		);
		expect(spec(validate(input, { specDir: dir }))).toContainEqual([
			"spec/violation",
			"",
			'article is missing required "hero"',
		]);
	});

	test("directories with different documents do not share compiled checks", () => {
		const first = documents((schema) => {
			schema.required.push("summary");
		});
		const second = documents((schema) => {
			schema.required.push("hero");
		});
		const bare = variant(example(), (a) => {
			delete a.summary;
			delete a.hero;
			a.media = [];
		});
		const messages = (dir: string) =>
			checkAgainstDocuments(bare, loadDocuments(dir)).map(
				(issue) => issue.message,
			);
		expect(messages(first)).toEqual(['article is missing required "summary"']);
		expect(messages(second)).toEqual(['article is missing required "hero"']);
	});
});

describe("broken documents", () => {
	const fails = (dir: string, message?: RegExp) => {
		expect(() => loadDocuments(dir)).toThrow(SpecDocumentsError);
		if (message) expect(() => loadDocuments(dir)).toThrow(message);
	};

	test("a missing directory", () => {
		fails(join(tmpdir(), "lox-documents-that-do-not-exist"), /cannot read/);
	});

	test("a missing second document", () => {
		const dir = documents();
		rmSync(join(dir, OPENAPI_FILE));
		fails(dir, new RegExp(OPENAPI_FILE.replaceAll(".", "\\.")));
	});

	test("invalid JSON", () => {
		fails(write("{not json", "{}", true), /not valid JSON/);
	});

	test("an OpenAPI document without ArticleSubmission", () => {
		fails(
			write(schemaDocument(), { components: { schemas: {} } }),
			/ArticleSubmission/,
		);
		fails(write(schemaDocument(), {}), /ArticleSubmission/);
	});

	test("documents that do not describe body or media items", () => {
		for (const part of ["body", "media"]) {
			for (const shape of [
				{},
				{ type: "array" },
				{ type: "array", items: {} },
				true,
			]) {
				const schema = schemaDocument();
				schema.properties[part] = shape;
				fails(write(schema, openApiDocument()), new RegExp(part));
				const openapi = openApiDocument();
				submission(openapi).properties[part] = shape;
				fails(write(schemaDocument(), openapi), new RegExp(part));
			}
		}
	});

	test("an unknown keyword, here or behind a reference, stops the check", () => {
		const schema = schemaDocument();
		schema.$defs.shortText.maxWords = 3;
		fails(write(schema, openApiDocument()), /maxWords/);
		const openapi = openApiDocument();
		submission(openapi).properties.title.maxWords = 3;
		fails(write(schemaDocument(), openapi), /maxWords/);
	});

	test("an unknown format stops the check", () => {
		const schema = schemaDocument();
		schema.$defs.mediaRef.format = "lox-ref";
		fails(write(schema, openApiDocument()), /lox-ref/);
	});

	test("a dangling reference stops the check", () => {
		const schema = schemaDocument();
		schema.properties.title = { $ref: "#/$defs/missing" };
		fails(write(schema, openApiDocument()));
	});

	test("validate throws for broken documents whatever the input", () => {
		const dir = join(tmpdir(), "lox-documents-that-do-not-exist");
		for (const input of [
			EXAMPLE_TEXT,
			"{",
			"[]",
			" ".repeat(16 * 1024 * 1024 + 1),
		]) {
			expect(() => validate(input, { specDir: dir })).toThrow(
				SpecDocumentsError,
			);
		}
	});

	test("a file that cannot be read as a file", () => {
		const dir = documents();
		rmSync(join(dir, SCHEMA_FILE));
		writeFileSync(join(dir, `${SCHEMA_FILE}.bak`), "{}");
		fails(dir, /cannot read/);
	});
});

describe("the tested versions", () => {
	test("only both tested hashes together are the tested documents", () => {
		const other = "0".repeat(64);
		expect(isTestedVersion(TESTED_SCHEMA_SHA256, TESTED_OPENAPI_SHA256)).toBe(
			true,
		);
		expect(isTestedVersion(TESTED_SCHEMA_SHA256, other)).toBe(false);
		expect(isTestedVersion(other, TESTED_OPENAPI_SHA256)).toBe(false);
		expect(isTestedVersion(TESTED_OPENAPI_SHA256, TESTED_SCHEMA_SHA256)).toBe(
			false,
		);
	});
});

describe("repairing the OpenAPI document", () => {
	const dto = (values: string, extra: object = {}) => ({
		type: "object",
		required: ["type", ...Object.keys(extra)],
		properties: { type: { type: "string", enum: values.split(",") }, ...extra },
	});
	const list = { type: "array", items: { type: "object" } };
	const synthetic = (schemas: object, body: object = list) => ({
		components: {
			schemas: {
				ArticleSubmission: { properties: { body, media: list } },
				...schemas,
			},
		},
	});
	const oneOf = (...names: string[]) => ({
		type: "array",
		items: {
			oneOf: names.map((name) => ({ $ref: `#/components/schemas/${name}` })),
		},
	});
	const shared = "text,link,lineBreak";
	const inlines = () =>
		synthetic(
			{
				TextRunDto: dto(shared, { text: { type: "string" } }),
				LineBreakDto: dto(shared),
			},
			oneOf("TextRunDto", "LineBreakDto"),
		);

	test("without repair a shared enum rejects a text run; with it the run passes", () => {
		const run = { body: [text()], media: [] };
		expect(compileOpenApi(inlines())(run)).not.toEqual([]);
		expect(compileOpenApi(repairOpenApi(inlines()))(run)).toEqual([]);
	});

	test("each DTO is pinned to its own tag", () => {
		const check = compileOpenApi(repairOpenApi(inlines()));
		expect(check({ body: [{ type: "lineBreak" }], media: [] })).toEqual([]);
		expect(check({ body: [{ type: "text" }], media: [] })).toEqual([
			expect.objectContaining({ pointer: "/body/0", keyword: "required" }),
		]);
		expect(check({ body: [{ type: "link" }], media: [] })).toEqual([
			expect.objectContaining({
				pointer: "/body/0/type",
				keyword: "discriminator",
			}),
		]);
	});

	test("the input document is not changed", () => {
		const original = inlines();
		const copy = structuredClone(original);
		repairOpenApi(original);
		expect(original).toEqual(copy);
	});

	test("an unknown DTO fails loudly and names it", () => {
		const document = synthetic(
			{
				ParagraphBlockDto: dto("paragraph,pullquote"),
				PullQuoteBlockDto: dto("paragraph,pullquote"),
			},
			oneOf("ParagraphBlockDto", "PullQuoteBlockDto"),
		);
		expect(() => repairOpenApi(document)).toThrow(SpecDocumentsError);
		expect(() => repairOpenApi(document)).toThrow(/PullQuoteBlockDto/);
	});

	test("a DTO whose enum lacks its own value fails loudly", () => {
		expect(() =>
			repairOpenApi(synthetic({ TextRunDto: dto("run") }, oneOf("TextRunDto"))),
		).toThrow(SpecDocumentsError);
	});

	test("a oneOf without a shared tag fails loudly", () => {
		const document = synthetic(
			{
				TextRunDto: { type: "object", properties: {} },
				LinkDto: { type: "object", properties: {} },
			},
			oneOf("TextRunDto", "LinkDto"),
		);
		expect(() => repairOpenApi(document)).toThrow(/cannot tell what separates/);
	});

	test("a reference to a missing DTO fails loudly", () => {
		expect(() => repairOpenApi(synthetic({}, oneOf("TextRunDto")))).toThrow(
			/unknown schema TextRunDto/,
		);
	});

	test("a oneOf mixing references and inline schemas fails loudly", () => {
		const document = synthetic(
			{ TextRunDto: dto(shared) },
			{
				type: "array",
				items: {
					oneOf: [
						{ $ref: "#/components/schemas/TextRunDto" },
						{ type: "string" },
					],
				},
			},
		);
		expect(() => repairOpenApi(document)).toThrow(SpecDocumentsError);
	});

	test("checksum DTOs are pinned on their algorithm, tying it to the digest length", () => {
		const checksumDto = (digest: number) => ({
			type: "object",
			required: ["algorithm", "value"],
			properties: {
				algorithm: { type: "string", enum: ["md5", "sha256"] },
				value: { type: "string", pattern: `^[0-9a-f]{${digest}}$` },
			},
		});
		const document = synthetic(
			{ Md5ChecksumDto: checksumDto(32), Sha256ChecksumDto: checksumDto(64) },
			oneOf("Md5ChecksumDto", "Sha256ChecksumDto"),
		);
		const shortSha = {
			body: [{ algorithm: "sha256", value: "a".repeat(32) }],
			media: [],
		};
		expect(compileOpenApi(document)(shortSha)).toEqual([]);
		expect(compileOpenApi(repairOpenApi(document))(shortSha)).toEqual([
			expect.objectContaining({ pointer: "/body/0/value", keyword: "pattern" }),
		]);
	});

	test("a document without oneOfs passes through unchanged", () => {
		const document = openApiDocument();
		expect(repairOpenApi(document)).toEqual(document);
	});
});

describe("suppression against the built-in rules", () => {
	test("a rejected root does not hide what the documents say about its items", () => {
		const schema = {
			...schemaDocument(),
			type: "array",
			items: { type: "integer" },
		};
		const dir = write(schema, openApiDocument());
		const result = validate('["x"]', { specDir: dir });
		expect(
			result.diagnostics.map((item) => [item.ruleId, item.pointer]),
		).toContainEqual(["spec/violation", "/0"]);
	});
});

describe("messages for rules only the documents have", () => {
	const issuesWith = (change: (schema: Json) => void, article: Json) =>
		spec(
			validate(pretty(article), {
				specDir: documents((schema) => change(schema)),
			}),
		);

	test("a format the built-in rules do not use is named, not called a URI", () => {
		expect(
			issuesWith(
				(schema) => {
					schema.$defs.shortText.format = "email";
				},
				{ ...example(), title: "geen adres" },
			),
		).toContainEqual([
			"spec/violation",
			"/title",
			'title "geen adres" is not a valid email',
		]);
	});

	test("a minimum length above one gives the actual length", () => {
		expect(
			issuesWith(
				(schema) => {
					schema.$defs.shortText.minLength = 5;
				},
				{ ...example(), title: "abc" },
			),
		).toContainEqual([
			"spec/violation",
			"/title",
			"title is 3 characters; the minimum is 5",
		]);
	});

	test("a rule on property names explains the rule the document has", () => {
		expect(
			issuesWith(
				(schema) => {
					schema.properties.extensions.propertyNames = { pattern: "^x-" };
				},
				{ ...example(), extensions: { example: {} } },
			),
		).toContainEqual([
			"spec/violation",
			"/extensions",
			'extensions has the property name "example", which must match the pattern ^x-',
		]);
	});

	test("a date-time format in the documents adds nothing to the built-in pattern", () => {
		const result = validate(
			pretty(
				variant(example(), (a) => {
					a.metadata.timestamps.publishedAt = "gisteren";
				}),
			),
			{
				specDir: documents((schema, openapi) => {
					for (const owner of [schema, submission(openapi)]) {
						const dateTime =
							owner === schema
								? schema.$defs.dateTime
								: owner.properties.metadata.properties.timestamps.properties
										.publishedAt;
						delete dateTime.pattern;
						dateTime.format = "date-time";
					}
				}),
			},
		);
		expect(spec(result).filter(([id]) => id === "spec/violation")).toEqual([]);
		expect(
			result.diagnostics.filter((item) => item.ruleId === "format/violation"),
		).toHaveLength(1);
	});
});

describe("other constraints on a value the built-in rules reject", () => {
	test("a document format next to a failed built-in pattern is still reported", () => {
		const input = pretty(
			variant(example(), (a) => {
				a.metadata.canonicalUrl = "ftp://example.com";
			}),
		);
		const result = validate(input, {
			specDir: documents((schema) => {
				schema.$defs.metadata.properties.canonicalUrl = {
					type: "string",
					format: "email",
				};
			}),
		});
		expect(spec(result)).toContainEqual([
			"spec/violation",
			"/metadata/canonicalUrl",
			'metadata canonicalUrl "ftp://example.com" is not a valid email',
		]);
	});
});

describe("tags", () => {
	test("an extension named like a tag rejects no other extension", () => {
		const result = validate(
			pretty({ ...example(), extensions: { type: 1, other: "x" } }),
			{
				specDir: documents((schema, openapi) => {
					// The schema rejects the extension called type by its type; the OpenAPI document
					// has a limit of its own on another extension.
					schema.properties.extensions.additionalProperties = {
						type: "string",
					};
					submission(openapi).properties.extensions.additionalProperties = {
						maxLength: 0,
					};
				}),
			},
		);
		expect(
			spec(result)
				.filter(([id]) => id === "spec/violation")
				.map(([, pointer]) => pointer),
		).toEqual(["/extensions/type", "/extensions/other"]);
	});
});

/** Removes the arm for `value` from every `oneOf` that `tag` chooses from. */
function dropArm(document: Json, tag: string, value: string): void {
	const resolve = (arm: Json): Json =>
		arm.$ref ? document.$defs[arm.$ref.slice("#/$defs/".length)] : arm;
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		const record = node as Json;
		if (record.discriminator?.propertyName === tag) {
			record.oneOf = record.oneOf.filter(
				(arm: Json) => resolve(arm).properties[tag].const !== value,
			);
		}
		for (const child of Object.values(record)) walk(child);
	};
	walk(document);
}

describe("a tag value only the documents reject", () => {
	// The built-in values would include the one just rejected, so they are no advice here.
	const input = pretty(full());
	test.each([
		["type", "paragraph"],
		["type", "text"],
		["method", "url"],
		["algorithm", "sha256"],
	])("%s %s is reported by either document without them", (tag, value) => {
		for (const which of ["schema", "openapi"] as const) {
			const result = validate(input, {
				specDir: documents((schema, openapi) =>
					dropArm(which === "schema" ? schema : openapi, tag, value),
				),
			});
			const messages = spec(result).filter(([id]) => id === "spec/violation");
			expect(messages.length).toBeGreaterThan(0);
			for (const [, pointer, message] of messages) {
				expect(pointer).toEndWith(`/${tag}`);
				expect(message).toEndWith(`has unknown ${tag} "${value}"`);
			}
		}
	});
});
