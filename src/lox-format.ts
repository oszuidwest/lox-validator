import Ajv2020, {
	type ErrorObject,
	type Options,
	type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
	escapePointerSegment,
	isObject,
	pointerPath,
	withinAny,
} from "./json-source.ts";

export interface FormatIssue {
	pointer: string;
	message: string;
	/** The JSON Schema keyword that failed. */
	keyword: string;
}

/** Two issues with this key say the same thing about the same value. */
const issueKey = (issue: FormatIssue): string =>
	`${issue.pointer} ${issue.message}`;

export const LIMITS = {
	bodyBlocks: 2000,
	mediaItems: 500,
	shortText: 1000,
	longText: 10000,
	textRun: 100000,
	marks: 7,
	richTextItems: 10000,
	linkChildren: 1000,
	listItems: 1000,
	headingLevelMin: 2,
	headingLevelMax: 6,
	url: 2048,
	ref: 255,
	mimeType: 255,
	identifier: 255,
	locale: 35,
	authors: 50,
	classifications: 200,
	dimension: 100000,
	durationSeconds: 31536000,
	byteSize: 9007199254740991,
	sourceIds: 20,
	extensions: 50,
} as const;

export const MARKS = [
	"bold",
	"italic",
	"underline",
	"strikethrough",
	"subscript",
	"superscript",
	"code",
] as const;

export const BLOCK_TYPES = [
	"paragraph",
	"heading",
	"image",
	"video",
	"audio",
	"list",
	"quote",
	"embed",
] as const;
export const INLINE_TYPES = ["text", "link", "lineBreak"] as const;
export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export const LIST_STYLES = ["ordered", "unordered"] as const;
export const DELIVERY_METHODS = ["url", "upload"] as const;
export const CHECKSUM_ALGORITHMS = ["md5", "sha1", "sha256"] as const;
export const RIGHTS_DISTRIBUTIONS = [
	"permitted",
	"restricted",
	"unknown",
] as const;
export const PUBLICATION_STATUSES = [
	"draft",
	"published",
	"retracted",
] as const;
export const DIMENSIONS = [
	"category",
	"location",
	"dossier",
	"theme",
	"topic",
	"tag",
] as const;

/**
 * Fields of the LOX article format that the submission API does not define. LOX sets the first
 * three itself; the last two belong to the stored article only. Their values are checked too.
 */
export const NOT_IN_SUBMISSION = {
	root: ["formatVersion", "contentType", "loxId", "extensions"],
	media: ["sourceIds"],
} as const;

const REF_PATTERN = "^(?!\\s)(?!.*\\s$)(?!\\.{1,2}$)[^/\\\\:\\p{Cc}]+$";
const URL_PATTERN = "^https?://";
const DELIVERY_URL_PATTERN = "^https?://[^{}\\s]+$";
const MIME_TYPE_PATTERN = "^[a-z]+/[a-z0-9][a-z0-9.+-]*$";
const IDENTIFIER_PATTERN = "^\\S(?:.*\\S)?$";
const LOCALE_PATTERN = "^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$";
const FORMAT_VERSION_PATTERN = "^1\\.(0|[1-9][0-9]{0,5})$";
const EXTENSION_NAME_PATTERN = "^[a-z0-9][a-z0-9.-]{0,63}$";
/**
 * Shared by the built-in pattern and the `date-time` format, so that a document checking timestamps
 * by format alone repeats the built-in message and adds nothing; a test in spec-documents guards it.
 */
const DATE_TIME_ADVICE =
	"is not an RFC 3339 date-time with an offset, such as 2026-11-07T14:30:00+01:00";
/** RFC 3339 section 5.6: the `date-time` format alone also lets +01 and +0100 through. */
const DATE_TIME_PATTERN =
	"^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[Zz]|[+-]\\d{2}:\\d{2})$";

const ref = (name: string) => ({ $ref: `#/$defs/${name}` });

const mediaBlock = (type: string) => ({
	type: "object",
	required: ["type", "ref"],
	properties: {
		type: { const: type },
		ref: ref("mediaRef"),
		caption: ref("longText"),
	},
});

const checksum = (algorithm: string, digestLength: number) => ({
	type: "object",
	required: ["algorithm", "value"],
	properties: {
		algorithm: { const: algorithm },
		value: { type: "string", pattern: `^[0-9a-f]{${digestLength}}$` },
	},
});

const boundedInteger = (maximum: number) => ({
	type: "integer",
	minimum: 1,
	maximum,
});

/**
 * What an article submission must satisfy: the submission API's `ArticleSubmission`, read as
 * strictly as the API and the article schema allow together. Where they differ, the stricter one
 * holds: integers where the API says number, and no empty list items.
 */
export const FORMAT_SCHEMA = {
	type: "object",
	required: ["externalId", "metadata", "title", "body", "media"],
	properties: {
		externalId: ref("identifier"),
		metadata: ref("metadata"),
		title: ref("shortText"),
		summary: ref("longText"),
		hero: {
			type: "object",
			required: ["ref"],
			properties: { ref: ref("mediaRef"), caption: ref("longText") },
		},
		body: {
			type: "array",
			minItems: 1,
			maxItems: LIMITS.bodyBlocks,
			items: ref("block"),
		},
		media: {
			type: "array",
			maxItems: LIMITS.mediaItems,
			items: ref("mediaDeclaration"),
		},
		formatVersion: { type: "string", pattern: FORMAT_VERSION_PATTERN },
		contentType: { const: "article" },
		loxId: { type: "string", format: "uuid" },
		extensions: {
			type: "object",
			maxProperties: LIMITS.extensions,
			propertyNames: { pattern: EXTENSION_NAME_PATTERN },
		},
	},
	$defs: {
		shortText: {
			textField: "line",
			type: "string",
			minLength: 1,
			maxLength: LIMITS.shortText,
		},
		longText: {
			textField: "lines",
			type: "string",
			minLength: 1,
			maxLength: LIMITS.longText,
		},
		identifier: {
			type: "string",
			minLength: 1,
			maxLength: LIMITS.identifier,
			pattern: IDENTIFIER_PATTERN,
		},
		httpUrl: {
			type: "string",
			format: "uri",
			maxLength: LIMITS.url,
			pattern: URL_PATTERN,
		},
		dateTime: {
			type: "string",
			format: "date-time",
			pattern: DATE_TIME_PATTERN,
		},
		mediaRef: {
			type: "string",
			minLength: 1,
			maxLength: LIMITS.ref,
			pattern: REF_PATTERN,
		},
		metadata: {
			type: "object",
			required: ["publicationStatus", "locale", "timestamps"],
			properties: {
				publicationStatus: { type: "string", enum: PUBLICATION_STATUSES },
				locale: {
					type: "string",
					maxLength: LIMITS.locale,
					pattern: LOCALE_PATTERN,
				},
				timestamps: {
					type: "object",
					required: ["updatedAt"],
					properties: {
						createdAt: ref("dateTime"),
						publishedAt: ref("dateTime"),
						updatedAt: ref("dateTime"),
					},
				},
				canonicalUrl: ref("httpUrl"),
				authors: {
					type: "array",
					maxItems: LIMITS.authors,
					items: {
						type: "object",
						required: ["name"],
						properties: {
							name: ref("shortText"),
							role: ref("shortText"),
							affiliation: ref("shortText"),
							sourceId: ref("identifier"),
						},
					},
				},
				classifications: {
					type: "array",
					maxItems: LIMITS.classifications,
					items: {
						type: "object",
						required: ["dimension", "label"],
						properties: {
							dimension: { type: "string", enum: DIMENSIONS },
							id: ref("identifier"),
							label: ref("shortText"),
						},
					},
				},
				rights: ref("rights"),
			},
		},
		textRun: {
			type: "object",
			required: ["type", "text"],
			properties: {
				type: { const: "text" },
				text: {
					textField: "run",
					type: "string",
					minLength: 1,
					maxLength: LIMITS.textRun,
				},
				marks: {
					type: "array",
					uniqueItems: true,
					maxItems: LIMITS.marks,
					items: { type: "string", enum: MARKS },
				},
			},
		},
		link: {
			type: "object",
			required: ["type", "href", "children"],
			properties: {
				type: { const: "link" },
				href: ref("httpUrl"),
				children: {
					type: "array",
					minItems: 1,
					maxItems: LIMITS.linkChildren,
					items: ref("textRun"),
				},
			},
		},
		lineBreak: {
			type: "object",
			required: ["type"],
			properties: { type: { const: "lineBreak" } },
		},
		inline: {
			type: "object",
			discriminator: { propertyName: "type" },
			oneOf: [ref("textRun"), ref("link"), ref("lineBreak")],
		},
		richText: {
			type: "array",
			minItems: 1,
			maxItems: LIMITS.richTextItems,
			items: ref("inline"),
		},
		block: {
			type: "object",
			discriminator: { propertyName: "type" },
			oneOf: [
				{
					type: "object",
					required: ["type", "content"],
					properties: {
						type: { const: "paragraph" },
						content: ref("richText"),
					},
				},
				{
					type: "object",
					required: ["type", "level", "text"],
					properties: {
						type: { const: "heading" },
						level: {
							type: "integer",
							minimum: LIMITS.headingLevelMin,
							maximum: LIMITS.headingLevelMax,
						},
						text: ref("shortText"),
					},
				},
				mediaBlock("image"),
				mediaBlock("video"),
				mediaBlock("audio"),
				{
					type: "object",
					required: ["type", "style", "items"],
					properties: {
						type: { const: "list" },
						style: { type: "string", enum: LIST_STYLES },
						items: {
							type: "array",
							minItems: 1,
							maxItems: LIMITS.listItems,
							items: ref("richText"),
						},
					},
				},
				{
					type: "object",
					required: ["type", "content"],
					properties: {
						type: { const: "quote" },
						content: ref("richText"),
						attribution: ref("shortText"),
					},
				},
				{
					type: "object",
					required: ["type", "url"],
					properties: {
						type: { const: "embed" },
						url: ref("httpUrl"),
						provider: ref("shortText"),
						title: ref("shortText"),
					},
				},
			],
		},
		rights: {
			type: "object",
			properties: {
				distribution: { type: "string", enum: RIGHTS_DISTRIBUTIONS },
				licence: {
					type: "object",
					required: ["id"],
					properties: { id: ref("identifier"), url: ref("httpUrl") },
				},
				copyrightHolder: ref("shortText"),
				copyrightNotice: ref("shortText"),
			},
		},
		mediaDeclaration: {
			type: "object",
			required: ["ref", "kind", "mimeType", "delivery"],
			properties: {
				ref: ref("mediaRef"),
				kind: { type: "string", enum: MEDIA_KINDS },
				mimeType: {
					type: "string",
					maxLength: LIMITS.mimeType,
					pattern: MIME_TYPE_PATTERN,
				},
				title: ref("shortText"),
				description: ref("longText"),
				credit: ref("shortText"),
				width: boundedInteger(LIMITS.dimension),
				height: boundedInteger(LIMITS.dimension),
				durationSeconds: boundedInteger(LIMITS.durationSeconds),
				byteSize: boundedInteger(LIMITS.byteSize),
				checksum: {
					type: "object",
					discriminator: { propertyName: "algorithm" },
					oneOf: [
						checksum("md5", 32),
						checksum("sha1", 40),
						checksum("sha256", 64),
					],
				},
				sourceIds: {
					type: "array",
					maxItems: LIMITS.sourceIds,
					items: {
						type: "object",
						required: ["system", "id"],
						properties: { system: ref("identifier"), id: ref("identifier") },
					},
				},
				rights: ref("rights"),
				delivery: {
					type: "object",
					discriminator: { propertyName: "method" },
					oneOf: [
						{
							type: "object",
							required: ["method", "url"],
							properties: {
								method: { const: "url" },
								url: {
									type: "string",
									format: "uri",
									maxLength: LIMITS.url,
									pattern: DELIVERY_URL_PATTERN,
								},
							},
						},
						{
							type: "object",
							required: ["method"],
							properties: {
								method: { const: "upload" },
								url: { type: "string" },
							},
						},
					],
				},
			},
		},
	},
} as const;

/**
 * A copy of `schema` in which every object with known properties allows no others. `extensions`
 * stays open: it has no `properties`, only rules for the names.
 */
function closeObjects(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(closeObjects);
	if (!isObject(schema)) return schema;
	const copy = Object.fromEntries(
		Object.entries(schema).map(([key, value]) => [key, closeObjects(value)]),
	);
	return "properties" in schema
		? { ...copy, additionalProperties: false }
		: copy;
}

/** The Ajv setup the built-in format and the LOX documents share, so both judge alike. */
export function createAjv(options: Options): Ajv2020 {
	// `discriminator` makes Ajv validate only the arm a value's tag selects, which keeps a bad text
	// run at one error instead of one per arm. In the 2020-12 dialect `format` is an annotation
	// unless a validator chooses to assert it; asserting it is this validator's policy.
	const ajv = new Ajv2020({ allErrors: true, discriminator: true, ...options });
	addFormats(ajv);
	return ajv;
}

export interface UnknownProperty {
	/** Pointer to the property itself. */
	pointer: string;
	name: string;
	/** The known properties of the object it sits in. */
	known: string[];
	/** The known properties that object lacks: what a misspelling may have meant. */
	absent: string[];
}

export interface FormatResult {
	/** One issue per real problem, each with a pointer into the article. */
	issues: FormatIssue[];
	/**
	 * Properties the format does not define. The format accepts them without saying what LOX does
	 * with them, so a misspelled optional field would not do what was meant and nothing would say so.
	 */
	unknown: UnknownProperty[];
	/**
	 * Each plain-text string the pass reaches, as the schema marks it with `textField`. Text in a
	 * property the format does not define, or in an element of unknown type, is not reached; both
	 * already get a diagnostic of their own.
	 */
	text: TextField[];
}

/**
 * How a text field may hold text: `line` is short text on one line, `lines` may span lines, and
 * `run` is a text run in rich text, where a lineBreak item marks a line break.
 */
type TextFieldKind = "line" | "lines" | "run";

export interface TextField {
	pointer: string;
	text: string;
	kind: TextFieldKind;
	/** A code-marked run, which may show markup on purpose. */
	code: boolean;
}

let compiled: ValidateFunction | undefined;
let collected: TextField[] = [];

function compileFormat(): ValidateFunction {
	const ajv = createAjv({ strict: true, verbose: true });
	// An annotation, not a constraint: it records each text value the pass reaches. Only the arm a
	// tag selects is reached, so text in an element of unknown type is not collected.
	ajv.addKeyword({
		keyword: "textField",
		metaSchema: { enum: ["line", "lines", "run"] },
		validate: (kind: TextFieldKind, text: unknown, _schema, data) => {
			if (typeof text !== "string" || data === undefined) return true;
			const owner = data.parentData as Record<string, unknown>;
			collected.push({
				pointer: data.instancePath,
				text,
				kind,
				code:
					kind === "run" &&
					Array.isArray(owner.marks) &&
					owner.marks.includes("code"),
			});
			return true;
		},
	});
	return ajv.compile(closeObjects(FORMAT_SCHEMA) as object);
}

/**
 * One pass over the closed schema finds all three. Every choice in the format goes by a
 * discriminator tag, so closing the objects changes no choice: the other errors are those of the
 * open schema.
 */
export function checkFormat(article: unknown): FormatResult {
	compiled ??= compileFormat();
	const validate = compiled;
	collected = [];
	let errors: ErrorObject[];
	let text: TextField[];
	try {
		validate(article);
		errors = validate.errors ?? [];
		text = collected;
	} finally {
		// Verbose errors and the collected text hold parts of the article; clear them, so that the
		// compiled function does not keep the article alive.
		validate.errors = null;
		collected = [];
	}
	const unknown = errors
		.filter((error) => error.keyword === "additionalProperties")
		.map((error): UnknownProperty => {
			const name = (error.params as { additionalProperty: string })
				.additionalProperty;
			const known = Object.keys(
				(error.parentSchema as { properties: object }).properties,
			);
			// With `verbose`, `data` is the object the property sits in.
			const owner = error.data as object;
			return {
				pointer: `${error.instancePath}/${escapePointerSegment(name)}`,
				name,
				known,
				absent: known.filter((field) => !Object.hasOwn(owner, field)),
			};
		});
	const violations = errors.filter(
		(error) => error.keyword !== "additionalProperties",
	);
	return { issues: issuesFromErrors(violations, article), unknown, text };
}

const ELEMENT_NAMES: Record<string, string> = {
	body: "block",
	content: "inline item",
	items: "list item",
	children: "link child",
	marks: "mark",
	media: "media declaration",
	sourceIds: "source id",
	authors: "author",
	classifications: "classification",
};
const OWNER_NAMES: Record<string, string> = {
	text: "text run",
	lineBreak: "line break",
};

function valueAt(root: unknown, path: readonly string[]): unknown {
	let value = root;
	for (const segment of path) {
		if (typeof value !== "object" || value === null) return undefined;
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

function typeOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" ? type : undefined;
}

const isIndex = (segment: string | undefined) =>
	segment !== undefined && /^\d+$/.test(segment);

const isInlineType = (type: string | undefined): type is string =>
	type !== undefined && (INLINE_TYPES as readonly string[]).includes(type);

const isKnownType = (type: string | undefined): type is string =>
	type !== undefined &&
	([...BLOCK_TYPES, ...INLINE_TYPES] as readonly string[]).includes(type);

/** A readable name for what lives at `path`, such as `heading text` or `text run`. */
function labelAt(root: unknown, path: readonly string[]): string {
	const key = path.at(-1);
	if (key === undefined) return "article";
	const inBody = path[0] === "body";

	if (isIndex(key)) {
		const type = typeOf(valueAt(root, path));
		if (path.length === 2 && inBody && isKnownType(type))
			return `${type} block`;
		if (inBody && isInlineType(type)) return OWNER_NAMES[type] ?? type;
		const container = path.at(-2) ?? "";
		return (
			(isIndex(container) ? "inline item" : ELEMENT_NAMES[container]) ??
			container
		);
	}

	if (path.length === 1) return key;
	const ownerType = inBody
		? typeOf(valueAt(root, path.slice(0, -1)))
		: undefined;
	if (isKnownType(ownerType))
		return `${OWNER_NAMES[ownerType] ?? ownerType} ${key}`;
	const parent = path.at(-2) ?? "";
	const owner = isIndex(parent) ? ELEMENT_NAMES[path.at(-3) ?? ""] : parent;
	return `${owner ?? parent} ${key}`;
}

export function show(value: unknown): string {
	if (typeof value === "number" && !Number.isFinite(value)) {
		return `${value} (a number too large to represent)`;
	}
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 80 ? `${text.slice(0, 76)}..."` : text;
}

/** Our own explanations, keyed on the pattern with JSON-only escaping of `/` removed. */
const PATTERN_ADVICE: Record<string, string> = {
	[REF_PATTERN]:
		'must be a filename: no /, \\ or :, no control characters, no leading or trailing whitespace, and not "." or ".."',
	[URL_PATTERN]: "must start with lowercase http:// or https://",
	[DELIVERY_URL_PATTERN]:
		"must start with lowercase http:// or https:// and contain no whitespace or braces",
	[MIME_TYPE_PATTERN]: "must be a lowercase type/subtype such as image/jpeg",
	[IDENTIFIER_PATTERN]:
		"must not start or end with whitespace or contain line breaks",
	[LOCALE_PATTERN]: "must be a BCP 47 language tag such as nl or nl-NL",
	[FORMAT_VERSION_PATTERN]: "must be 1.<minor>, such as 1.0",
	[DATE_TIME_PATTERN]: DATE_TIME_ADVICE,
	[EXTENSION_NAME_PATTERN]:
		"must be a lowercase namespace of letters, digits, dots and hyphens, at most 64 characters",
};

function patternAdvice(pattern: string): string {
	const normalized = pattern.replaceAll("\\/", "/");
	const digest = /^\^\[0-9a-f\]\{(\d+)\}\$$/.exec(normalized);
	if (digest) return `must be ${digest[1]} lowercase hexadecimal characters`;
	return PATTERN_ADVICE[normalized] ?? `must match the pattern ${pattern}`;
}

const FORMAT_ADVICE: Record<string, string> = {
	"date-time": DATE_TIME_ADVICE,
	uuid: "is not a UUID",
	uri: "is not a valid URI; percent-encode non-ASCII characters and remove whitespace",
};

const formatAdvice = (format: string): string =>
	FORMAT_ADVICE[format] ?? `is not a valid ${format}`;

/** The properties that tell which kind of element an object is, and the kinds each allows. */
const TAG_VALUES: Record<
	string,
	(path: readonly string[]) => readonly string[]
> = {
	type: (path) => (path.length === 2 ? BLOCK_TYPES : INLINE_TYPES),
	method: () => DELIVERY_METHODS,
	algorithm: () => CHECKSUM_ALGORITHMS,
};

/** The fields of Ajv's `params` used below; each keyword sets its own. */
interface AjvParams {
	limit: number;
	pattern: string;
	format: string;
	missingProperty: string;
	type: string;
	allowedValues: string[];
	allowedValue: unknown;
	i: number;
	tag: string;
	tagValue: unknown;
}

function toIssue(
	error: ErrorObject,
	root: unknown,
	suggestTags: boolean,
): FormatIssue {
	const pointer = error.instancePath;
	const path = pointerPath(pointer);
	const value = valueAt(root, path);
	const label = labelAt(root, path);
	const params = error.params as AjvParams;
	const limit = params.limit;
	const issue = (message: string, at = pointer) => ({
		pointer: at,
		message,
		keyword: error.keyword,
	});

	// A rule on property names reports each failing name with the keyword it failed.
	if (error.propertyName !== undefined) {
		const advice =
			error.keyword === "pattern"
				? patternAdvice(params.pattern)
				: (error.message ?? `fails ${error.keyword}`);
		return {
			pointer,
			keyword: "propertyNames",
			message: `${label} has the property name ${show(error.propertyName)}, which ${advice}`,
		};
	}

	switch (error.keyword) {
		case "maxLength":
			return issue(
				`${label} is ${[...(value as string)].length} characters; the maximum is ${limit}`,
			);
		case "minLength": {
			const length = [...(value as string)].length;
			return issue(
				length === 0
					? `${label} is empty; it needs at least ${limit} character`
					: `${label} is ${length} characters; the minimum is ${limit}`,
			);
		}
		case "maxItems":
			return issue(
				`${label} has ${(value as unknown[]).length} items; the maximum is ${limit}`,
			);
		case "minItems":
			if ((value as unknown[]).length === 0)
				return issue(`${label} is empty; it needs at least ${limit} item`);
			return issue(
				`${label} has ${(value as unknown[]).length} items; the minimum is ${limit}`,
			);
		case "maxProperties":
			return issue(
				`${label} has ${Object.keys(value as object).length} properties; the maximum is ${limit}`,
			);
		case "minimum":
			return issue(`${label} is ${value}; the minimum is ${limit}`);
		case "maximum":
			return issue(`${label} is ${value}; the maximum is ${limit}`);
		case "pattern":
			return issue(`${label} ${show(value)} ${patternAdvice(params.pattern)}`);
		case "format":
			return issue(`${label} ${show(value)} ${formatAdvice(params.format)}`);
		case "required":
			return issue(
				`${label} is missing required ${show(params.missingProperty)}`,
			);
		case "type":
			return issue(
				`${label} must be ${params.type === "integer" ? "a whole number" : `of type ${params.type}`}; it is ${show(value)}`,
			);
		case "enum":
			return issue(
				`${label} ${show(value)} is not allowed; use one of ${params.allowedValues.join(", ")}`,
			);
		case "const":
			return issue(
				`${label} ${show(value)} is not allowed here; only ${show(params.allowedValue)} is`,
			);
		case "uniqueItems":
			return issue(
				`${label} repeats ${show((value as unknown[])[params.i])}; each value may appear once`,
			);
		case "discriminator": {
			const tag = params.tag;
			const values = suggestTags ? TAG_VALUES[tag]?.(path) : undefined;
			const advice = values ? `; use one of ${values.join(", ")}` : "";
			return params.tagValue === undefined
				? issue(`${label} is missing required ${show(tag)}${advice}`)
				: issue(
						`${label} has unknown ${tag} ${show(params.tagValue)}${advice}`,
						`${pointer}/${tag}`,
					);
		}
		default:
			return issue(`${label} ${error.message ?? `fails ${error.keyword}`}`);
	}
}

/**
 * The element whose tag `pointer` names, or null when it names no tag. Extension names are free,
 * so an extension called `type` is no tag.
 */
function taggedElement(pointer: string): string | null {
	const cut = pointer.lastIndexOf("/");
	const owner = pointer.slice(0, cut);
	return Object.hasOwn(TAG_VALUES, pointer.slice(cut + 1)) &&
		owner !== "/extensions"
		? owner
		: null;
}

/** Keywords that reject a value as a whole: by its type, or as the wrong kind of element. */
const WHOLESALE = new Set(["type", "const", "discriminator"]);

/**
 * The value `issue` rejects as a whole, which makes every other issue in it moot, or null when it
 * is about one constraint only. A failed tag rejects its element.
 */
function rejectedWhole(issue: FormatIssue): string | null {
	if (!WHOLESALE.has(issue.keyword)) return null;
	return taggedElement(issue.pointer) ?? issue.pointer;
}

/** Per keyword, the keyword whose failure on the same value already says all it would. */
const COVERED_BY: Record<string, string> = {
	format: "pattern",
	pattern: "minLength",
};

/**
 * What the issues so far say, so that a later source adds only news: not the same message, and
 * nothing inside a value already rejected as a whole. Another constraint on the same value is news,
 * even of the same keyword: a stricter limit, or a format next to a built-in pattern. A rejected
 * root covers only itself: documents that allow a non-object article may still say something
 * about its items.
 */
export class Reported {
	private readonly said = new Set<string>();
	private readonly whole = new Set<string>();
	private rootRejected = false;

	private isNews(issue: FormatIssue): boolean {
		return (
			!this.said.has(issueKey(issue)) &&
			!(issue.pointer === ""
				? this.rootRejected
				: withinAny(issue.pointer, this.whole))
		);
	}

	/** Records `issues` and returns those that are news. */
	add(issues: readonly FormatIssue[]): FormatIssue[] {
		const news = issues.filter((issue) => this.isNews(issue));
		for (const issue of news) {
			this.said.add(issueKey(issue));
			const value = rejectedWhole(issue);
			if (value === "") this.rootRejected = true;
			else if (value !== null) this.whole.add(value);
		}
		// The same message twice within one source counts once.
		const seen = new Set<string>();
		return news.filter((issue) => {
			const key = issueKey(issue);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
}

/**
 * Turns Ajv errors into one issue per problem: a wrong element type makes the rest of that element
 * meaningless, a wrong value type makes its other keywords moot, and a keyword in COVERED_BY gives
 * way to the one it maps to.
 * `propertyNames` comes with an error per failing name, which says more; the summary is dropped.
 * `suggestTags` lists the built-in values for a failed tag: wrong for documents, which may differ.
 */
export function issuesFromErrors(
	errors: readonly ErrorObject[],
	root: unknown,
	{ suggestTags = true } = {},
): FormatIssue[] {
	const wrongElements = new Set<string>();
	for (const error of errors) {
		const element =
			error.keyword === "const" ? taggedElement(error.instancePath) : null;
		if (element !== null) wrongElements.add(element);
	}
	const failed = new Set(
		errors.map((error) => `${error.instancePath} ${error.keyword}`),
	);

	return errors
		.filter((error) => {
			const at = error.instancePath;
			if (error.keyword !== "const" && withinAny(at, wrongElements))
				return false;
			if (error.keyword === "propertyNames") return false;
			// A value of the wrong type fails every other keyword too, with less to say.
			if (error.keyword !== "type" && failed.has(`${at} type`)) return false;
			const coveredBy = COVERED_BY[error.keyword];
			return coveredBy === undefined || !failed.has(`${at} ${coveredBy}`);
		})
		.map((error) => toIssue(error, root, suggestTags));
}
