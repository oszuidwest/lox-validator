import { describe, expect, test } from "bun:test";
import { pointerPath } from "../src/json-source.ts";
import {
	BLOCK_TYPES,
	CHECKSUM_ALGORITHMS,
	checkFormat,
	DIMENSIONS,
	LIMITS,
	LIST_STYLES,
	MARKS,
	MEDIA_KINDS,
	NOT_IN_SUBMISSION,
	PUBLICATION_STATUSES,
	RIGHTS_DISTRIBUTIONS,
	show,
} from "../src/lox-format.ts";
import {
	DIGESTS,
	full,
	type Json,
	lineBreak,
	link,
	minimal,
	paragraph,
	text,
	variant,
} from "./fixtures.ts";

const x = (length: number) => "x".repeat(length);
const issuesOf = (change: (article: Json) => void, base = full()) =>
	checkFormat(variant(base, change)).issues;

test("the full and minimal fixtures pass and have no unknown properties", () => {
	for (const article of [full(), minimal()]) {
		const { issues, unknown } = checkFormat(article);
		expect(issues).toEqual([]);
		expect(unknown).toEqual([]);
	}
});

/**
 * One row per constraint value: a change to the full fixture and what it must give, either nothing
 * or exactly one issue with this pointer and keyword, whose message names `field`.
 */
type Expected = [pointer: string, keyword: string, field: string];
type Row = [
	name: string,
	change: (article: Json) => void,
	expected: Expected | null,
];

const set =
	(path: string, value: unknown) =>
	(article: Json): void => {
		const segments = pointerPath(path);
		const last = segments.pop() as string;
		let owner = article;
		for (const segment of segments) owner = owner[segment];
		if (value === undefined) delete owner[last];
		else owner[last] = value;
	};
const remove = (path: string) => set(path, undefined);

/** Passing at the boundary, failing one past it, for a string limit. */
const stringLimits = (path: string, max: number, field: string): Row[] => [
	[`${path} of ${max} characters`, set(path, x(max)), null],
	[
		`${path} of ${max + 1} characters`,
		set(path, x(max + 1)),
		[path, "maxLength", field],
	],
	[`${path} empty`, set(path, ""), [path, "minLength", field]],
	[`${path} of 1 character`, set(path, x(1)), null],
	[`${path} as a number`, set(path, 1), [path, "type", field]],
];
const shortText = (path: string, field: string) =>
	stringLimits(path, LIMITS.shortText, field);
const longText = (path: string, field: string) =>
	stringLimits(path, LIMITS.longText, field);

const identifier = (path: string, field: string): Row[] => [
	...stringLimits(path, LIMITS.identifier, field),
	[`${path} with a leading space`, set(path, " a"), [path, "pattern", field]],
	[`${path} with a trailing space`, set(path, "a "), [path, "pattern", field]],
	[`${path} with a line break`, set(path, "a\nb"), [path, "pattern", field]],
	[`${path} with a trailing tab`, set(path, "a\t"), [path, "pattern", field]],
	[`${path} with an inner space`, set(path, "a b"), null],
	[`${path} of only a space`, set(path, " "), [path, "pattern", field]],
];

const httpUrl = (path: string, field: string): Row[] => {
	const prefix = "https://x.nl/";
	return [
		[`${path} https`, set(path, "https://x.nl/a?b=c#d"), null],
		[`${path} http`, set(path, "http://x.nl"), null],
		[`${path} ftp`, set(path, "ftp://x.nl"), [path, "pattern", field]],
		[
			`${path} uppercase scheme`,
			set(path, "HTTPS://x.nl"),
			[path, "pattern", field],
		],
		[`${path} relative`, set(path, "/nieuws/1"), [path, "pattern", field]],
		[
			`${path} with a space`,
			set(path, "https://x.nl/a b"),
			[path, "format", field],
		],
		[
			`${path} non-ASCII`,
			set(path, "https://x.nl/café"),
			[path, "format", field],
		],
		[
			`${path} ftp with a space gives only the pattern issue`,
			set(path, "ftp://x y"),
			[path, "pattern", field],
		],
		[
			`${path} of ${LIMITS.url} characters`,
			set(path, prefix + x(LIMITS.url - prefix.length)),
			null,
		],
		[
			`${path} of ${LIMITS.url + 1} characters`,
			set(path, prefix + x(LIMITS.url + 1 - prefix.length)),
			[path, "maxLength", field],
		],
		[`${path} as a number`, set(path, 1), [path, "type", field]],
	];
};

const mediaRef = (path: string, field: string): Row[] => [
	...stringLimits(path, LIMITS.ref, field),
	[
		`${path} of ${LIMITS.ref} astral characters`,
		set(path, "😀".repeat(LIMITS.ref)),
		null,
	],
	[
		`${path} of ${LIMITS.ref + 1} astral characters`,
		set(path, "😀".repeat(LIMITS.ref + 1)),
		[path, "maxLength", field],
	],
	[`${path} with a slash`, set(path, "a/b.jpg"), [path, "pattern", field]],
	[`${path} with a backslash`, set(path, "a\\b.jpg"), [path, "pattern", field]],
	[`${path} with a colon`, set(path, "c:b.jpg"), [path, "pattern", field]],
	[
		`${path} with a control character`,
		set(path, "a\u0007.jpg"),
		[path, "pattern", field],
	],
	[`${path} with DEL`, set(path, "a\u007f.jpg"), [path, "pattern", field]],
	[`${path} "."`, set(path, "."), [path, "pattern", field]],
	[`${path} ".."`, set(path, ".."), [path, "pattern", field]],
	[`${path} "..."`, set(path, "..."), null],
	[`${path} ".jpg"`, set(path, ".jpg"), null],
	[
		`${path} with a leading space`,
		set(path, " a.jpg"),
		[path, "pattern", field],
	],
	[
		`${path} with a trailing no-break space`,
		set(path, "a.jpg "),
		[path, "pattern", field],
	],
	[
		`${path} with an inner space and accents`,
		set(path, "één foto (1).jpg"),
		null,
	],
];

const dateTime = (path: string, field: string): Row[] => [
	[`${path} with an offset`, set(path, "2026-11-07T14:30:00+01:00"), null],
	[`${path} with Z`, set(path, "2026-11-07T14:30:00Z"), null],
	[
		`${path} with fractions`,
		set(path, "2026-11-07T14:30:00.123456-05:30"),
		null,
	],
	[
		`${path} without an offset`,
		set(path, "2026-11-07T14:30:00"),
		[path, "pattern", field],
	],
	[`${path} as a date`, set(path, "2026-11-07"), [path, "pattern", field]],
	[
		`${path} with an hour-only offset`,
		set(path, "2026-11-07T14:30:00+01"),
		[path, "pattern", field],
	],
	[
		`${path} with an offset without a colon`,
		set(path, "2026-11-07T14:30:00+0100"),
		[path, "pattern", field],
	],
	[`${path} with lowercase t and z`, set(path, "2026-11-07t14:30:00z"), null],
	[
		`${path} on a day that does not exist`,
		set(path, "2026-02-30T10:00:00Z"),
		[path, "format", field],
	],
	[
		`${path} at hour 24`,
		set(path, "2026-11-07T24:00:00Z"),
		[path, "format", field],
	],
	[`${path} as a Unix time`, set(path, 1762520000), [path, "type", field]],
	[`${path} empty`, set(path, ""), [path, "pattern", field]],
];

const integer = (path: string, max: number, field: string): Row[] => [
	[`${path} 1`, set(path, 1), null],
	[`${path} ${max}`, set(path, max), null],
	[`${path} 0`, set(path, 0), [path, "minimum", field]],
	[`${path} -1`, set(path, -1), [path, "minimum", field]],
	[`${path} ${max + 1}`, set(path, max + 1), [path, "maximum", field]],
	[`${path} 1.5`, set(path, 1.5), [path, "type", field]],
	[`${path} as a string`, set(path, "2"), [path, "type", field]],
];

const enumOf = (
	path: string,
	values: readonly string[],
	field: string,
): Row[] => [
	...values.map(
		(value): Row => [
			`${path} ${JSON.stringify(value)}`,
			set(path, value),
			null,
		],
	),
	[`${path} unknown`, set(path, "other"), [path, "enum", field]],
	[
		`${path} in another case`,
		set(path, values[0]?.toUpperCase()),
		[path, "enum", field],
	],
];

const arrayLimit = (
	path: string,
	max: number,
	item: () => unknown,
	field: string,
): Row[] => [
	[
		`${path} of ${max} items`,
		set(path, Array.from({ length: max }, item)),
		null,
	],
	[
		`${path} of ${max + 1} items`,
		set(path, Array.from({ length: max + 1 }, item)),
		[path, "maxItems", field],
	],
	[`${path} as an object`, set(path, {}), [path, "type", field]],
];

const required = (owner: string, names: string[], field: string): Row[] =>
	names
		.map(
			(name): Row => [
				`${owner} without ${name}`,
				remove(`${owner}/${name}`),
				[owner, "required", name],
			],
		)
		.concat([
			[`${owner} as a string`, set(owner, "x"), [owner, "type", field]],
		]);

const P = "/body/0/content/0";

const rows: Row[] = [
	// The article itself
	...["externalId", "metadata", "title", "body", "media"].map(
		(name): Row => [
			`without ${name}`,
			remove(`/${name}`),
			["", "required", name],
		],
	),
	[
		"without summary, hero",
		(a) => {
			delete a.summary;
			delete a.hero;
			a.media.shift();
		},
		null,
	],
	...identifier("/externalId", "externalId"),
	[
		"/externalId as null",
		set("/externalId", null),
		["/externalId", "type", "externalId"],
	],
	...shortText("/title", "title"),
	["/title of 1000 astral characters", set("/title", "😀".repeat(1000)), null],
	[
		"/title of 1001 astral characters",
		set("/title", "😀".repeat(1001)),
		["/title", "maxLength", "title"],
	],
	...longText("/summary", "summary"),
	["/body empty", set("/body", []), ["/body", "minItems", "body"]],
	...arrayLimit("/body", LIMITS.bodyBlocks, () => paragraph(), "body"),
	[
		"/media empty",
		(a) => {
			a.media = [];
			delete a.hero;
			a.body = [paragraph()];
		},
		null,
	],
	...arrayLimit(
		"/media",
		LIMITS.mediaItems,
		() => ({
			ref: "a.jpg",
			kind: "image",
			mimeType: "image/jpeg",
			delivery: { method: "upload" },
		}),
		"media",
	),

	// Metadata
	...required(
		"/metadata",
		["publicationStatus", "locale", "timestamps"],
		"metadata",
	),
	...enumOf(
		"/metadata/publicationStatus",
		PUBLICATION_STATUSES,
		"publicationStatus",
	),
	["/metadata/locale nl", set("/metadata/locale", "nl"), null],
	["/metadata/locale nds", set("/metadata/locale", "nds"), null],
	["/metadata/locale zh-Hant-TW", set("/metadata/locale", "zh-Hant-TW"), null],
	[
		"/metadata/locale of 35 characters",
		set("/metadata/locale", `nl${"-abcdefgh".repeat(3)}-abcde`),
		null,
	],
	[
		"/metadata/locale of 36 characters",
		set("/metadata/locale", `nl${"-abcdefgh".repeat(3)}-abcdef`),
		["/metadata/locale", "maxLength", "locale"],
	],
	[
		"/metadata/locale with an underscore",
		set("/metadata/locale", "nl_NL"),
		["/metadata/locale", "pattern", "locale"],
	],
	[
		"/metadata/locale of 1 letter",
		set("/metadata/locale", "n"),
		["/metadata/locale", "pattern", "locale"],
	],
	[
		"/metadata/locale of 4 letters",
		set("/metadata/locale", "nlnl"),
		["/metadata/locale", "pattern", "locale"],
	],
	[
		"/metadata/locale with a trailing hyphen",
		set("/metadata/locale", "nl-"),
		["/metadata/locale", "pattern", "locale"],
	],
	[
		"/metadata/locale with a subtag of 9",
		set("/metadata/locale", "nl-abcdefghi"),
		["/metadata/locale", "pattern", "locale"],
	],
	[
		"/metadata/locale empty",
		set("/metadata/locale", ""),
		["/metadata/locale", "pattern", "locale"],
	],
	...required("/metadata/timestamps", ["updatedAt"], "timestamps"),
	[
		"/metadata/timestamps with only updatedAt",
		set("/metadata/timestamps", { updatedAt: "2026-11-07T10:00:00Z" }),
		null,
	],
	...dateTime("/metadata/timestamps/createdAt", "createdAt"),
	...dateTime("/metadata/timestamps/publishedAt", "publishedAt"),
	...dateTime("/metadata/timestamps/updatedAt", "updatedAt"),
	...httpUrl("/metadata/canonicalUrl", "canonicalUrl"),
	...arrayLimit(
		"/metadata/authors",
		LIMITS.authors,
		() => ({ name: "A" }),
		"authors",
	),
	...required("/metadata/authors/0", ["name"], "author"),
	...shortText("/metadata/authors/0/name", "author name"),
	...shortText("/metadata/authors/0/role", "author role"),
	...shortText("/metadata/authors/0/affiliation", "author affiliation"),
	...identifier("/metadata/authors/0/sourceId", "author sourceId"),
	...arrayLimit(
		"/metadata/classifications",
		LIMITS.classifications,
		() => ({ dimension: "tag", label: "t" }),
		"classifications",
	),
	...required(
		"/metadata/classifications/0",
		["dimension", "label"],
		"classification",
	),
	...enumOf(
		"/metadata/classifications/0/dimension",
		DIMENSIONS,
		"classification dimension",
	),
	...identifier("/metadata/classifications/0/id", "classification id"),
	...shortText("/metadata/classifications/0/label", "classification label"),

	// Rights, at article and media level
	...["/metadata/rights", "/media/0/rights"].flatMap((at): Row[] => [
		[`${at} empty`, set(at, {}), null],
		[`${at} as an array`, set(at, []), [at, "type", "rights"]],
		...enumOf(`${at}/distribution`, RIGHTS_DISTRIBUTIONS, "distribution"),
		...required(`${at}/licence`, ["id"], "licence"),
		...identifier(`${at}/licence/id`, "licence id"),
		...httpUrl(`${at}/licence/url`, "licence url"),
		...shortText(`${at}/copyrightHolder`, "copyrightHolder"),
		...shortText(`${at}/copyrightNotice`, "copyrightNotice"),
	]),

	// Hero
	...required("/hero", ["ref"], "hero"),
	...mediaRef("/hero/ref", "hero ref"),
	...longText("/hero/caption", "hero caption"),

	// Blocks
	[
		"a block without type",
		set("/body/0", { content: [text()] }),
		["/body/0", "discriminator", "type"],
	],
	[
		"a block of unknown type",
		set("/body/0", { type: "table", rows: [] }),
		["/body/0/type", "discriminator", "table"],
	],
	[
		"a block whose type is a number",
		set("/body/0", { type: 5 }),
		["/body/0/type", "discriminator", "type"],
	],
	[
		"a block whose type is in another case",
		set("/body/0/type", "Paragraph"),
		["/body/0/type", "discriminator", "Paragraph"],
	],
	["a block as a string", set("/body/0", "x"), ["/body/0", "type", "block"]],
	["a block as null", set("/body/0", null), ["/body/0", "type", "block"]],
	[
		"a block as an array",
		set("/body/0", [text()]),
		["/body/0", "type", "block"],
	],
	...required("/body/0", ["content"], "paragraph block").slice(0, 1),
	...required("/body/1", ["level", "text"], "heading block").slice(0, 2),
	...integer("/body/1/level", LIMITS.headingLevelMax, "heading level").filter(
		([name]) => !/ 1$| 0$| -1$/.test(name),
	),
	["/body/1/level 2", set("/body/1/level", 2), null],
	[
		"/body/1/level 1",
		set("/body/1/level", 1),
		["/body/1/level", "minimum", "heading level"],
	],
	["/body/1/level 2.0 parses as 2", set("/body/1/level", 2.0), null],
	...shortText("/body/1/text", "heading text"),
	...(["/body/3", "/body/4", "/body/5"] as const).flatMap(
		(at, index): Row[] => {
			const kind = MEDIA_KINDS[index] as string;
			return [
				...required(at, ["ref"], `${kind} block`).slice(0, 1),
				...mediaRef(`${at}/ref`, `${kind} ref`),
				...longText(`${at}/caption`, `${kind} caption`),
			];
		},
	),
	...required("/body/6", ["style", "items"], "list block").slice(0, 2),
	...enumOf("/body/6/style", LIST_STYLES, "list style"),
	[
		"/body/6/items empty",
		set("/body/6/items", []),
		["/body/6/items", "minItems", "list items"],
	],
	...arrayLimit(
		"/body/6/items",
		LIMITS.listItems,
		() => [text()],
		"list items",
	),
	[
		"an empty list item",
		set("/body/6/items/0", []),
		["/body/6/items/0", "minItems", "list item"],
	],
	[
		"a list item of only a line break",
		set("/body/6/items/0", [lineBreak()]),
		null,
	],
	[
		"a list item as a string",
		set("/body/6/items/0", "x"),
		["/body/6/items/0", "type", "list item"],
	],
	...arrayLimit(
		"/body/6/items/0",
		LIMITS.richTextItems,
		() => lineBreak(),
		"list item",
	),
	...required("/body/8", ["content"], "quote block").slice(0, 1),
	...shortText("/body/8/attribution", "quote attribution"),
	[
		"an empty quote",
		set("/body/8/content", []),
		["/body/8/content", "minItems", "quote content"],
	],
	...required("/body/9", ["url"], "embed block").slice(0, 1),
	...httpUrl("/body/9/url", "embed url"),
	...shortText("/body/9/provider", "embed provider"),
	...shortText("/body/9/title", "embed title"),

	// Rich text and inline items
	[
		"an empty paragraph",
		set("/body/0/content", []),
		["/body/0/content", "minItems", "paragraph content"],
	],
	...arrayLimit(
		"/body/0/content",
		LIMITS.richTextItems,
		() => lineBreak(),
		"paragraph content",
	),
	[
		"paragraph content as a string",
		set("/body/0/content", "x"),
		["/body/0/content", "type", "paragraph content"],
	],
	[
		"an inline without type",
		set(P, { text: "x" }),
		[P, "discriminator", "type"],
	],
	[
		"an inline of unknown type",
		set(P, { type: "image", ref: "a" }),
		[`${P}/type`, "discriminator", "image"],
	],
	[
		"a block type used as an inline",
		set(P, { type: "heading" }),
		[`${P}/type`, "discriminator", "heading"],
	],
	["an inline as a string", set(P, "x"), [P, "type", "inline item"]],
	...required(P, ["text"], "text run").slice(0, 1),
	["a text run of one space", set(`${P}/text`, " "), null],
	...stringLimits(`${P}/text`, LIMITS.textRun, "text run text"),
	...MARKS.map(
		(mark): Row => [`the mark ${mark}`, set(`${P}/marks`, [mark]), null],
	),
	["every mark once", set(`${P}/marks`, [...MARKS]), null],
	["no marks", set(`${P}/marks`, []), null],
	[
		"an unknown mark",
		set(`${P}/marks`, ["big"]),
		[`${P}/marks/0`, "enum", "mark"],
	],
	[
		"a mark in another case",
		set(`${P}/marks`, ["Bold"]),
		[`${P}/marks/0`, "enum", "mark"],
	],
	[
		"a repeated mark",
		set(`${P}/marks`, ["bold", "italic", "bold"]),
		[`${P}/marks`, "uniqueItems", "marks"],
	],
	[
		"marks as a string",
		set(`${P}/marks`, "bold"),
		[`${P}/marks`, "type", "marks"],
	],
	[
		"a line break with extra fields",
		set(P, { type: "lineBreak", count: 2 }),
		null,
	],
	...required("/body/0/content/3", ["href", "children"], "link").slice(0, 2),
	...httpUrl("/body/0/content/3/href", "link href"),
	[
		"a link without children",
		set("/body/0/content/3/children", []),
		["/body/0/content/3/children", "minItems", "link children"],
	],
	...arrayLimit(
		"/body/0/content/3/children",
		LIMITS.linkChildren,
		() => text(),
		"link children",
	),
	[
		"a line break inside a link",
		set("/body/0/content/3/children/0", lineBreak()),
		["/body/0/content/3/children/0/type", "const", "lineBreak"],
	],
	[
		"a link inside a link",
		set("/body/0/content/3/children/0", link()),
		["/body/0/content/3/children/0/type", "const", "link"],
	],
	[
		"an empty run inside a link",
		set("/body/0/content/3/children/0/text", ""),
		["/body/0/content/3/children/0/text", "minLength", "text"],
	],

	// Media declarations
	...required(
		"/media/0",
		["ref", "kind", "mimeType", "delivery"],
		"media declaration",
	),
	...mediaRef("/media/0/ref", "media declaration ref"),
	...enumOf("/media/0/kind", MEDIA_KINDS, "kind"),
	[
		"/media/0/mimeType image/svg+xml",
		set("/media/0/mimeType", "image/svg+xml"),
		null,
	],
	[
		"/media/0/mimeType application/vnd.apple.mpegurl",
		set("/media/0/mimeType", "application/vnd.apple.mpegurl"),
		null,
	],
	[
		"/media/0/mimeType uppercase",
		set("/media/0/mimeType", "image/JPEG"),
		["/media/0/mimeType", "pattern", "mimeType"],
	],
	[
		"/media/0/mimeType without subtype",
		set("/media/0/mimeType", "image"),
		["/media/0/mimeType", "pattern", "mimeType"],
	],
	[
		"/media/0/mimeType with parameters",
		set("/media/0/mimeType", "audio/mpeg; q=1"),
		["/media/0/mimeType", "pattern", "mimeType"],
	],
	[
		"/media/0/mimeType with a leading dot subtype",
		set("/media/0/mimeType", "image/.x"),
		["/media/0/mimeType", "pattern", "mimeType"],
	],
	[
		"/media/0/mimeType empty",
		set("/media/0/mimeType", ""),
		["/media/0/mimeType", "pattern", "mimeType"],
	],
	[
		"/media/0/mimeType of 255 characters",
		set("/media/0/mimeType", `image/${x(LIMITS.mimeType - 6)}`),
		null,
	],
	[
		"/media/0/mimeType of 256 characters",
		set("/media/0/mimeType", `image/${x(LIMITS.mimeType - 5)}`),
		["/media/0/mimeType", "maxLength", "mimeType"],
	],
	...shortText("/media/0/title", "media declaration title"),
	...longText("/media/0/description", "media declaration description"),
	...shortText("/media/0/credit", "media declaration credit"),
	...integer("/media/0/width", LIMITS.dimension, "width"),
	...integer("/media/0/height", LIMITS.dimension, "height"),
	...integer(
		"/media/2/durationSeconds",
		LIMITS.durationSeconds,
		"durationSeconds",
	),
	...integer("/media/1/byteSize", LIMITS.byteSize, "byteSize").filter(
		([name]) => !name.endsWith(String(LIMITS.byteSize + 1)),
	),
	[
		"/media/1/byteSize 2^53",
		set("/media/1/byteSize", 2 ** 53),
		["/media/1/byteSize", "maximum", "byteSize"],
	],

	// Checksums
	...CHECKSUM_ALGORITHMS.flatMap((algorithm): Row[] => {
		const digest = DIGESTS[algorithm];
		const at = "/media/1/checksum";
		return [
			[`a ${algorithm} checksum`, set(at, { algorithm, value: digest }), null],
			[
				`a ${algorithm} checksum one short`,
				set(at, { algorithm, value: digest.slice(1) }),
				[`${at}/value`, "pattern", "checksum value"],
			],
			[
				`a ${algorithm} checksum one long`,
				set(at, { algorithm, value: `${digest}0` }),
				[`${at}/value`, "pattern", "checksum value"],
			],
			[
				`a ${algorithm} checksum in uppercase`,
				set(at, { algorithm, value: digest.toUpperCase() }),
				[`${at}/value`, "pattern", "checksum value"],
			],
			[
				`a ${algorithm} checksum with a non-hex character`,
				set(at, { algorithm, value: `g${digest.slice(1)}` }),
				[`${at}/value`, "pattern", "checksum value"],
			],
			[
				`a ${algorithm} checksum without value`,
				set(at, { algorithm }),
				[at, "required", "value"],
			],
		];
	}),
	[
		"a sha256 checksum with an md5 digest",
		set("/media/1/checksum", { algorithm: "sha256", value: DIGESTS.md5 }),
		["/media/1/checksum/value", "pattern", "64"],
	],
	[
		"an md5 checksum with a sha256 digest",
		set("/media/1/checksum", { algorithm: "md5", value: DIGESTS.sha256 }),
		["/media/1/checksum/value", "pattern", "32"],
	],
	[
		"a checksum of unknown algorithm",
		set("/media/1/checksum", { algorithm: "crc32", value: "0" }),
		["/media/1/checksum/algorithm", "discriminator", "crc32"],
	],
	[
		"a checksum without algorithm",
		set("/media/1/checksum", { value: DIGESTS.md5 }),
		["/media/1/checksum", "discriminator", "algorithm"],
	],
	[
		"a checksum as a string",
		set("/media/1/checksum", DIGESTS.md5),
		["/media/1/checksum", "type", "checksum"],
	],

	// Delivery
	[
		"url delivery without url",
		set("/media/0/delivery", { method: "url" }),
		["/media/0/delivery", "required", "url"],
	],
	[
		"delivery of unknown method",
		set("/media/0/delivery", { method: "ftp", url: "ftp://x" }),
		["/media/0/delivery/method", "discriminator", "ftp"],
	],
	[
		"delivery without method",
		set("/media/0/delivery", { url: "https://x.nl/a.jpg" }),
		["/media/0/delivery", "discriminator", "method"],
	],
	[
		"delivery as a string",
		set("/media/0/delivery", "https://x.nl/a.jpg"),
		["/media/0/delivery", "type", "delivery"],
	],
	[
		"delivery url with braces",
		set("/media/0/delivery/url", "https://x.nl/{id}.jpg"),
		["/media/0/delivery/url", "pattern", "delivery url"],
	],
	[
		"delivery url with a space",
		set("/media/0/delivery/url", "https://x.nl/a b.jpg"),
		["/media/0/delivery/url", "pattern", "delivery url"],
	],
	[
		"delivery url with a tab",
		set("/media/0/delivery/url", "https://x.nl/a\tb.jpg"),
		["/media/0/delivery/url", "pattern", "delivery url"],
	],
	[
		"delivery url uppercase scheme",
		set("/media/0/delivery/url", "HTTPS://x.nl/a.jpg"),
		["/media/0/delivery/url", "pattern", "delivery url"],
	],
	[
		"delivery url empty",
		set("/media/0/delivery/url", ""),
		["/media/0/delivery/url", "pattern", "delivery url"],
	],
	[
		"delivery url non-ASCII",
		set("/media/0/delivery/url", "https://x.nl/café.jpg"),
		["/media/0/delivery/url", "format", "delivery url"],
	],
	[
		"delivery url of 2048 characters",
		set("/media/0/delivery/url", `https://x.nl/${x(LIMITS.url - 13)}`),
		null,
	],
	[
		"delivery url of 2049 characters",
		set("/media/0/delivery/url", `https://x.nl/${x(LIMITS.url - 12)}`),
		["/media/0/delivery/url", "maxLength", "delivery url"],
	],
	[
		"upload delivery with a url string passes the format",
		set("/media/1/delivery/url", "anything"),
		null,
	],
	[
		"upload delivery with a numeric url",
		set("/media/1/delivery/url", 1),
		["/media/1/delivery/url", "type", "delivery url"],
	],

	// Fields of the article format outside the submission
	["formatVersion 1.0", set("/formatVersion", "1.0"), null],
	["formatVersion 1.999999", set("/formatVersion", "1.999999"), null],
	[
		"formatVersion 1.1000000",
		set("/formatVersion", "1.1000000"),
		["/formatVersion", "pattern", "formatVersion"],
	],
	[
		"formatVersion 1.01",
		set("/formatVersion", "1.01"),
		["/formatVersion", "pattern", "formatVersion"],
	],
	[
		"formatVersion 2.0",
		set("/formatVersion", "2.0"),
		["/formatVersion", "pattern", "formatVersion"],
	],
	[
		"formatVersion 1",
		set("/formatVersion", "1"),
		["/formatVersion", "pattern", "formatVersion"],
	],
	[
		"formatVersion as a number",
		set("/formatVersion", 1.0),
		["/formatVersion", "type", "formatVersion"],
	],
	["contentType article", set("/contentType", "article"), null],
	[
		"contentType blog",
		set("/contentType", "blog"),
		["/contentType", "const", "contentType"],
	],
	["loxId a UUID", set("/loxId", "0b6a4f3e-8f6e-4c1d-9a2b-3c4d5e6f7a8b"), null],
	["loxId not a UUID", set("/loxId", "lox-1"), ["/loxId", "format", "loxId"]],
	[
		"extensions with free contents",
		set("/extensions", {
			example: { anything: [1, { deep: null }] },
			"a.b-c": 1,
		}),
		null,
	],
	[
		"extensions of 50 names",
		set(
			"/extensions",
			Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`n${i}`, i])),
		),
		null,
	],
	[
		"extensions of 51 names",
		set(
			"/extensions",
			Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`n${i}`, i])),
		),
		["/extensions", "maxProperties", "extensions"],
	],
	[
		"an extension name of 64 characters",
		set("/extensions", { [x(64)]: 1 }),
		null,
	],
	[
		"an extension name of 65 characters",
		set("/extensions", { [x(65)]: 1 }),
		["/extensions", "propertyNames", "extensions"],
	],
	[
		"an extension name in uppercase",
		set("/extensions", { Example: 1 }),
		["/extensions", "propertyNames", "Example"],
	],
	[
		"an extension name starting with a hyphen",
		set("/extensions", { "-x": 1 }),
		["/extensions", "propertyNames", "-x"],
	],
	[
		"an extension name with a slash",
		set("/extensions", { "a/b": 1 }),
		["/extensions", "propertyNames", "a/b"],
	],
	[
		"extensions as an array",
		set("/extensions", []),
		["/extensions", "type", "extensions"],
	],
	[
		"source ids",
		set("/media/0/sourceIds", [{ system: "example-system", id: "123" }]),
		null,
	],
	...arrayLimit(
		"/media/0/sourceIds",
		LIMITS.sourceIds,
		() => ({ system: "s", id: "1" }),
		"sourceIds",
	),
	[
		"a source id without system",
		set("/media/0/sourceIds", [{ id: "1" }]),
		["/media/0/sourceIds/0", "required", "system"],
	],
	[
		"a source id without id",
		set("/media/0/sourceIds", [{ system: "s" }]),
		["/media/0/sourceIds/0", "required", "id"],
	],
	[
		"a source id with a padded system",
		set("/media/0/sourceIds", [{ system: " s", id: "1" }]),
		["/media/0/sourceIds/0/system", "pattern", "system"],
	],
];

describe("every constraint passes at its limit and fails past it", () => {
	for (const [name, change, expected] of rows) {
		test(name, () => {
			const issues = issuesOf(change);
			if (expected === null) {
				expect(issues).toEqual([]);
				return;
			}
			const [pointer, keyword, field] = expected;
			// Exactly one issue: no echo from other keywords on the same value.
			expect(
				issues.map(({ pointer, keyword }) => ({ pointer, keyword })),
			).toEqual([{ pointer, keyword }]);
			expect(issues[0]?.message).toContain(field);
		});
	}
});

describe("every enum value and every tag is accepted", () => {
	test("each block type with its required fields", () => {
		const blocks: Record<(typeof BLOCK_TYPES)[number], object> = {
			paragraph: paragraph(),
			heading: { type: "heading", level: 3, text: "K" },
			image: { type: "image", ref: "a" },
			video: { type: "video", ref: "a" },
			audio: { type: "audio", ref: "a" },
			list: { type: "list", style: "ordered", items: [[text()]] },
			quote: { type: "quote", content: [text()] },
			embed: { type: "embed", url: "https://x.nl" },
		};
		for (const block of Object.values(blocks)) {
			expect(
				issuesOf((a) => {
					a.body = [block];
				}, minimal()),
			).toEqual([]);
		}
	});
});

describe("messages", () => {
	test("eight marks exceed the limit; the report names the limit", () => {
		const issues = issuesOf(set(`${P}/marks`, [...MARKS, "bold"]));
		expect(issues).toContainEqual({
			pointer: `${P}/marks`,
			keyword: "maxItems",
			message: "text run marks has 8 items; the maximum is 7",
		});
	});

	test("a missing required property names the property and its owner", () => {
		expect(issuesOf(remove("/metadata/timestamps/updatedAt"))).toEqual([
			{
				pointer: "/metadata/timestamps",
				keyword: "required",
				message: 'metadata timestamps is missing required "updatedAt"',
			},
		]);
	});

	test("length counts characters, not UTF-16 code units", () => {
		const [issue] = issuesOf(set("/title", "😀".repeat(1001)));
		expect(issue?.message).toBe(
			"title is 1001 characters; the maximum is 1000",
		);
	});

	test("an unknown tag lists the allowed ones and points at the tag", () => {
		expect(issuesOf(set("/body/0", { type: "table" }))).toEqual([
			{
				pointer: "/body/0/type",
				keyword: "discriminator",
				message: `block has unknown type "table"; use one of ${BLOCK_TYPES.join(", ")}`,
			},
		]);
		expect(issuesOf(set(P, { type: "image" }))[0]?.message).toContain(
			"use one of text, link, lineBreak",
		);
		expect(
			issuesOf(set("/media/0/delivery/method", "s3"))[0]?.message,
		).toContain("use one of url, upload");
		expect(
			issuesOf(set("/media/1/checksum/algorithm", "crc"))[0]?.message,
		).toContain("use one of md5, sha1, sha256");
	});

	test("a whole number is asked for in words", () => {
		expect(issuesOf(set("/media/0/width", 1.5))[0]?.message).toBe(
			"media declaration width must be a whole number; it is 1.5",
		);
	});

	test("a checksum of the wrong length says which length", () => {
		expect(
			issuesOf(
				set("/media/1/checksum", { algorithm: "sha1", value: DIGESTS.md5 }),
			)[0]?.message,
		).toContain("must be 40 lowercase hexadecimal characters");
	});

	test("our own advice replaces the raw pattern", () => {
		for (const [path, value] of [
			["/hero/ref", "a/b"],
			["/metadata/canonicalUrl", "ftp://x"],
			["/media/0/delivery/url", "https://x.nl/{a}"],
			["/media/0/mimeType", "IMAGE/x"],
			["/externalId", " a"],
			["/metadata/locale", "nl_NL"],
			["/formatVersion", "2"],
		] as const) {
			const message = issuesOf(set(path, value))[0]?.message ?? "";
			expect(message).not.toContain("must match the pattern");
			expect(message).not.toContain("^");
		}
	});

	test("long values are shortened in messages", () => {
		const message = issuesOf(
			set("/metadata/canonicalUrl", `ftp://${x(500)}`),
		)[0]?.message;
		expect(message?.length).toBeLessThan(200);
		expect(message).toContain('..."');
	});

	test("show() keeps short values and shortens long ones", () => {
		expect(show("abc")).toBe('"abc"');
		expect(show(1.5)).toBe("1.5");
		expect(show(x(200))).toBe(`"${x(75)}..."`);
		expect(show(x(200))).toHaveLength(80);
		expect(show(Number.POSITIVE_INFINITY)).toContain("too large");
		expect(show(undefined)).toBe("undefined");
	});
});

describe("one issue per problem", () => {
	test("an element of the wrong kind gives one issue, not one per field", () => {
		const issues = issuesOf(
			set("/body/0/content/3/children/0", {
				type: "link",
				href: "nope",
				children: [],
				text: "",
			}),
		);
		expect(issues).toHaveLength(1);
	});

	test("independent problems each give their own issue", () => {
		const issues = issuesOf((a) => {
			a.title = "";
			a.metadata.locale = "nl_NL";
			a.media[0].width = 0;
		});
		expect(issues.map((issue) => issue.pointer).sort()).toEqual([
			"/media/0/width",
			"/metadata/locale",
			"/title",
		]);
	});

	test("the same problem in many places gives one issue each, without duplicates", () => {
		const issues = issuesOf((a) => {
			a.body = Array.from({ length: 50 }, () => ({
				type: "heading",
				level: 9,
				text: "",
			}));
		});
		expect(issues).toHaveLength(100);
		const keys = issues.map((issue) => `${issue.pointer} ${issue.keyword}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe("non-object roots", () => {
	for (const root of [[], null, "x", 42, true]) {
		test(`${JSON.stringify(root)} gives one type issue at the root`, () => {
			const { issues, unknown } = checkFormat(root);
			expect(issues).toEqual([
				{
					pointer: "",
					keyword: "type",
					message: `article must be of type object; it is ${JSON.stringify(root)}`,
				},
			]);
			expect(unknown).toEqual([]);
		});
	}
});

describe("unknown properties", () => {
	const unknown = (change: (article: Json) => void) =>
		checkFormat(variant(full(), change)).unknown;

	test("a misspelled field is found with the known fields of its object", () => {
		expect(
			unknown((a) => {
				a.hero.captoin = "x";
			}),
		).toEqual([
			{
				pointer: "/hero/captoin",
				name: "captoin",
				known: ["ref", "caption"],
				absent: [],
			},
		]);
	});

	test("unknown fields are found at every level", () => {
		const found = unknown((a) => {
			a.titel = "x";
			a.metadata.timestamps.modifiedAt = "x";
			a.metadata.authors[0].email = "x";
			a.metadata.rights.licence.name = "x";
			a.body[0].content[0].style = "x";
			a.body[0].content[3].children[0].lang = "x";
			a.body[0].content[2].count = 2;
			a.body[6].start = 3;
			a.media[0].delivery.headers = {};
			a.media[1].checksum.encoding = "hex";
			a.media[0].sourceIds = [{ system: "s", id: "1", url: "x" }];
		});
		expect(found.map((item) => item.pointer).sort()).toEqual(
			[
				"/titel",
				"/metadata/timestamps/modifiedAt",
				"/metadata/authors/0/email",
				"/metadata/rights/licence/name",
				"/body/0/content/0/style",
				"/body/0/content/3/children/0/lang",
				"/body/0/content/2/count",
				"/body/6/start",
				"/media/0/delivery/headers",
				"/media/1/checksum/encoding",
				"/media/0/sourceIds/0/url",
			].sort(),
		);
	});

	test("only the arm the tag selects counts", () => {
		// `url` belongs to url delivery and to upload delivery; `ref` belongs to no paragraph.
		expect(
			unknown((a) => {
				a.body[0].ref = "a";
			}),
		).toEqual([
			{
				pointer: "/body/0/ref",
				name: "ref",
				known: ["type", "content"],
				absent: [],
			},
		]);
		expect(
			unknown((a) => {
				a.media[1].delivery.url = "x";
			}),
		).toEqual([]);
	});

	test("unknown properties do not make the format fail", () => {
		expect(
			issuesOf((a) => {
				a.hero.captoin = "x";
			}),
		).toEqual([]);
	});

	test("the contents of extensions are free", () => {
		expect(
			unknown((a) => {
				a.extensions = { example: { anything: { nested: [{ goes: 1 }] } } };
			}),
		).toEqual([]);
	});

	test("an element with an unknown tag gets no unknown-property noise", () => {
		expect(
			unknown((a) => {
				a.body[0] = { type: "table", rows: [] };
			}),
		).toEqual([]);
	});

	test("names with ~ and / are escaped in the pointer", () => {
		expect(
			unknown((a) => {
				a.hero["a/b~c"] = 1;
			}),
		).toEqual([
			{
				pointer: "/hero/a~1b~0c",
				name: "a/b~c",
				known: ["ref", "caption"],
				absent: [],
			},
		]);
	});

	test("absent lists the known fields the owner lacks", () => {
		expect(
			unknown((a) => {
				delete a.hero.caption;
				a.hero.captoin = "x";
			}).map((item) => item.absent),
		).toEqual([["caption"]]);
	});

	test("__proto__ is an unknown property like any other", () => {
		const article = full();
		Object.defineProperty(article.hero, "__proto__", {
			value: 1,
			enumerable: true,
			configurable: true,
			writable: true,
		});
		expect(checkFormat(article).unknown.map((item) => item.name)).toEqual([
			"__proto__",
		]);
	});

	test("fields outside the submission are known fields, not unknown ones", () => {
		expect(
			unknown((a) => {
				for (const field of NOT_IN_SUBMISSION.root) a[field] = undefined;
				a.formatVersion = "1.0";
				a.contentType = "article";
				a.loxId = "0b6a4f3e-8f6e-4c1d-9a2b-3c4d5e6f7a8b";
				a.extensions = {};
				a.media[0].sourceIds = [];
			}),
		).toEqual([]);
	});
});

test("pointerPath unescapes ~1 before ~0", () => {
	expect(pointerPath("")).toEqual([]);
	expect(pointerPath("/a~1b/~01/~0")).toEqual(["a/b", "~1", "~"]);
});
