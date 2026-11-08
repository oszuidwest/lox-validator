import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { isObject, type JsonObject as Json } from "./json-source.ts";
import {
	createAjv,
	type FormatIssue,
	issuesFromErrors,
	Reported,
} from "./lox-format.ts";
import type { SpecCheck } from "./types.ts";

export const TESTED_SCHEMA_SHA256 =
	"63a267b8e5746242ff23777068cf331868e9a23504e8dc0812b2ea79200ee25c";
export const TESTED_OPENAPI_SHA256 =
	"75f57a9c352f42ac6fe255304aba403dfd08f34d4fed71fadc17fb7e9fc479c2";

export const SCHEMA_FILE = "lox-v1.schema.json";
export const OPENAPI_FILE = "lox-api.openapi.json";

export class SpecDocumentsError extends Error {}

type CheckPart = (article: unknown) => FormatIssue[];

interface CompiledDocuments {
	checkSchema: CheckPart;
	checkOpenApi: CheckPart;
}

interface LoadedDocuments extends CompiledDocuments {
	specCheck: SpecCheck;
}

/** The tag each DTO stands for; the DTO's own enum lists every sibling's value too. */
const DISCRIMINATOR_VALUES: Record<string, string> = {
	TextRunDto: "text",
	LinkDto: "link",
	LineBreakDto: "lineBreak",
	ParagraphBlockDto: "paragraph",
	HeadingBlockDto: "heading",
	ImageBlockDto: "image",
	VideoBlockDto: "video",
	AudioBlockDto: "audio",
	ListBlockDto: "list",
	QuoteBlockDto: "quote",
	EmbedBlockDto: "embed",
	UrlDeliveryDto: "url",
	UploadDeliveryDto: "upload",
	Md5ChecksumDto: "md5",
	Sha1ChecksumDto: "sha1",
	Sha256ChecksumDto: "sha256",
};

const REF_PREFIX = "#/components/schemas/";

function dtoNameOf(arm: unknown): string | undefined {
	const target = isObject(arm) ? arm.$ref : undefined;
	return typeof target === "string" && target.startsWith(REF_PREFIX)
		? target.slice(REF_PREFIX.length)
		: undefined;
}

function tagOptions(dto: Json, property: string): unknown[] | undefined {
	const schema = (dto.properties as Json | undefined)?.[property];
	if (!isObject(schema)) return undefined;
	if ("const" in schema) return [schema.const];
	return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function pinOneOf(node: Json, arms: unknown[], schemas: Json): void {
	const dtos = arms.map((arm) => {
		const name = dtoNameOf(arm);
		if (name === undefined) {
			throw new SpecDocumentsError(
				"a oneOf in the OpenAPI document mixes component references with other schemas",
			);
		}
		const dto = schemas[name];
		if (!isObject(dto)) {
			throw new SpecDocumentsError(
				`the OpenAPI document references the unknown schema ${name}`,
			);
		}
		return { name, dto };
	});

	const [first] = dtos;
	const tags = Object.keys(
		(first?.dto.properties as Json | undefined) ?? {},
	).filter((property) =>
		dtos.every(
			({ dto }) =>
				tagOptions(dto, property) !== undefined &&
				(dto.required as unknown[] | undefined)?.includes(property),
		),
	);
	const tag = tags[0];
	if (tag === undefined || tags.length > 1) {
		throw new SpecDocumentsError(
			`cannot tell what separates ${dtos.map(({ name }) => name).join(", ")} in the OpenAPI document`,
		);
	}

	for (const { name, dto } of dtos) {
		const value = DISCRIMINATOR_VALUES[name];
		if (value === undefined) {
			throw new SpecDocumentsError(
				`the OpenAPI document has a oneOf with the unknown schema ${name}; the validator does not know its ${tag} value`,
			);
		}
		if (!tagOptions(dto, tag)?.includes(value)) {
			throw new SpecDocumentsError(
				`${name} in the OpenAPI document does not allow ${tag} "${value}"`,
			);
		}
		(dto.properties as Json)[tag] = { const: value };
	}
	node.type = "object";
	node.discriminator = { propertyName: tag };
}

function repairNode(node: unknown, schemas: Json, seen: Set<string>): void {
	if (Array.isArray(node)) {
		for (const item of node) repairNode(item, schemas, seen);
		return;
	}
	if (!isObject(node)) return;

	const name = dtoNameOf(node);
	if (name !== undefined) {
		if (seen.has(name)) return;
		seen.add(name);
		repairNode(schemas[name], schemas, seen);
		return;
	}
	if (
		Array.isArray(node.oneOf) &&
		node.oneOf.some((arm) => isObject(arm) && "$ref" in arm)
	) {
		pinOneOf(node, node.oneOf, schemas);
	}
	for (const value of Object.values(node)) repairNode(value, schemas, seen);
}

/** Without one of these on `items`, every block and media item would pass. */
const ITEM_KEYWORDS = ["type", "$ref", "oneOf", "anyOf", "allOf", "properties"];

function assertListPart(part: unknown, name: string, owner: string): void {
	const items = isObject(part) && part.type === "array" ? part.items : null;
	if (!isObject(items) || !ITEM_KEYWORDS.some((keyword) => keyword in items)) {
		throw new SpecDocumentsError(
			`${name} in ${owner} is not an array schema that describes its items`,
		);
	}
}

/** The article root of a document, after checking it constrains body and media at all. */
function articleRoot(root: unknown, owner: string): Json {
	const properties = isObject(root) ? root.properties : undefined;
	if (!isObject(root) || !isObject(properties)) {
		throw new SpecDocumentsError(`${owner} has no properties`);
	}
	assertListPart(properties.body, "body", owner);
	assertListPart(properties.media, "media", owner);
	return root;
}

function submissionRoot(document: unknown): Json {
	const components = isObject(document) ? document.components : undefined;
	const schemas = isObject(components) ? components.schemas : undefined;
	if (!isObject(schemas) || !("ArticleSubmission" in schemas)) {
		throw new SpecDocumentsError(`${OPENAPI_FILE} has no ArticleSubmission`);
	}
	return articleRoot(
		schemas.ArticleSubmission,
		`ArticleSubmission in ${OPENAPI_FILE}`,
	);
}

/**
 * The `oneOf`s in the submission list DTOs that share one non-exclusive enum for their tag, on
 * objects that allow unknown properties, without a discriminator. A value therefore matches every
 * DTO whose required fields it happens to have: paragraphs, quotes, media blocks, text runs, links
 * and url delivery match two or more arms and are rejected, while headings, embeds, line breaks
 * and `{method:"upload"}` match one, and a checksum's algorithm is not tied to its digest length.
 *
 * Returns a repaired copy. For each such `oneOf` reachable from ArticleSubmission:
 * 1. Find the tag: the one required property every DTO constrains with an enum or const.
 * 2. Replace the tag in each DTO with a const, from DISCRIMINATOR_VALUES by DTO name. A DTO without
 *    a known value, or whose enum does not allow that value, throws SpecDocumentsError.
 * 3. Declare the tag as the `oneOf`'s discriminator, on `type: object`.
 *
 * This is our reading of what the document means. A submission passing the repaired document is not
 * evidence that the LOX server accepts it.
 */
export function repairOpenApi(document: unknown): Json {
	const repaired = structuredClone(document) as Json;
	// Checks the shape first, so the casts below hold.
	const root = submissionRoot(repaired);
	const schemas = (repaired.components as Json).schemas as Json;
	repairNode(root, schemas, new Set<string>());
	return repaired;
}

/**
 * Strict about what a schema says, so a keyword or format this validator cannot enforce stops the
 * check, instead of passing as if it held. Not strict about style, which the documents do not follow.
 */
function createDocumentAjv() {
	const ajv = createAjv({
		strictSchema: true,
		strictNumbers: true,
		strictTypes: false,
		strictTuples: false,
		strictRequired: false,
	});
	ajv.addKeyword("example");
	// Holds the definitions that `$ref` points into. What is referenced is compiled, strictly.
	ajv.addKeyword("components");
	return ajv;
}

function compileRoot(root: Json): CheckPart {
	const validate: ValidateFunction = createDocumentAjv().compile(root);
	return (article) => {
		validate(article);
		return issuesFromErrors(validate.errors ?? [], article, {
			suggestTags: false,
		});
	};
}

/** Compiles ArticleSubmission of an OpenAPI document as given; repair it first if needed. */
export function compileOpenApi(document: unknown): CheckPart {
	const root = submissionRoot(document);
	return compileRoot({ ...root, components: (document as Json).components });
}

/**
 * The schema describes the article as LOX stores it, with two fields LOX adds. A submission
 * without them gets the values LOX would set, so the rest can be checked against the schema.
 */
function compileSchema(document: unknown): CheckPart {
	const check = compileRoot(articleRoot(document, SCHEMA_FILE));
	return (article) =>
		check(
			isObject(article)
				? { formatVersion: "1.0", contentType: "article", ...article }
				: article,
		);
}

interface DocumentFile {
	path: string;
	bytes: Buffer;
	sha256: string;
}

function readDocument(dir: string, file: string): DocumentFile {
	const path = join(dir, file);
	try {
		const bytes = readFileSync(path);
		return {
			path,
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	} catch (error) {
		throw new SpecDocumentsError(`cannot read ${path}: ${String(error)}`);
	}
}

function parseDocument({ path, bytes }: DocumentFile): unknown {
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new SpecDocumentsError(`${path} is not valid JSON: ${String(error)}`);
	}
}

const compiledByContent = new Map<string, CompiledDocuments>();

/**
 * One process can check many articles against the same documents. Their hashes are taken on every
 * call, so an edit is never missed; parsing and compiling happen once per content.
 */
function compileDocuments(
	schema: DocumentFile,
	openapi: DocumentFile,
): CompiledDocuments {
	const key = `${schema.sha256} ${openapi.sha256}`;
	const cached = compiledByContent.get(key);
	if (cached) return cached;
	const schemaDocument = parseDocument(schema);
	const openapiDocument = parseDocument(openapi);
	try {
		const compiled = {
			checkSchema: compileSchema(schemaDocument),
			checkOpenApi: compileOpenApi(repairOpenApi(openapiDocument)),
		};
		compiledByContent.set(key, compiled);
		return compiled;
	} catch (error) {
		if (error instanceof SpecDocumentsError) throw error;
		throw new SpecDocumentsError(
			`the LOX documents do not compile: ${String(error)}`,
		);
	}
}

export function isTestedVersion(
	schemaSha256: string,
	openapiSha256: string,
): boolean {
	return (
		schemaSha256 === TESTED_SCHEMA_SHA256 &&
		openapiSha256 === TESTED_OPENAPI_SHA256
	);
}

export function loadDocuments(dir: string): LoadedDocuments {
	const schema = readDocument(dir, SCHEMA_FILE);
	const openapi = readDocument(dir, OPENAPI_FILE);
	return {
		specCheck: {
			dir,
			schemaSha256: schema.sha256,
			openapiSha256: openapi.sha256,
			matchesTested: isTestedVersion(schema.sha256, openapi.sha256),
		},
		...compileDocuments(schema, openapi),
	};
}

/** The issues of either document that `reported` does not say already; records them in it. */
export function checkAgainstDocuments(
	article: unknown,
	documents: CompiledDocuments,
	reported = new Reported(),
): FormatIssue[] {
	return [
		...reported.add(documents.checkSchema(article)),
		...reported.add(documents.checkOpenApi(article)),
	];
}
