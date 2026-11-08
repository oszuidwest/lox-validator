import type { Rule } from "./types.ts";

const JSON_POLICY =
	"Policy of this validator, after the interoperability advice in RFC 8259";
const FORMAT = "LOX submission API and article schema, the stricter of the two";
const API = "LOX submission API";
const SCHEMA = "LOX article schema";
const CONSISTENCY =
	"Consistency rule of this validator; the documents do not state it";

const CATALOG = {
	"json/syntax": {
		severity: "error",
		summary: "The input is not valid JSON",
		why: "The submission API takes a JSON request body.",
		fix: "Correct the JSON at this position. Comments, trailing commas, single quotes and a byte order mark are not allowed.",
		basis: "JSON (RFC 8259)",
	},
	"json/duplicate-key": {
		severity: "error",
		summary: "An object has the same property twice",
		why: "RFC 8259 leaves the result to the parser. Most keep only the last value without warning, so one of the two is lost, and which one depends on the server.",
		fix: "Keep one of the two properties.",
		basis: JSON_POLICY,
	},
	"json/invalid-string": {
		severity: "error",
		summary: "A string holds a lone surrogate escape such as \\ud800",
		why: "JSON's grammar allows it, but half a surrogate pair is no character: RFC 8259 warns that parsers handle it unpredictably, and the text cannot be stored or shown as written.",
		fix: "Write the character itself, or the full surrogate pair.",
		basis: JSON_POLICY,
	},
	"input/too-large": {
		severity: "error",
		summary: "The input is larger than this validator reads",
		why: "A guard of this validator against runaway input. The format bounds almost every field, so a real article is far smaller.",
		fix: "Check that the input is one article submission.",
		basis: "This validator",
	},
	"format/violation": {
		severity: "error",
		summary: "The submission breaks a rule of the LOX format",
		why: "The submission API or the article schema rejects this value. Where they differ, the stricter one applies, because LOX validates the article against its format.",
		fix: "Change the value at the pointer as the message says.",
		basis: FORMAT,
	},
	"format/unknown-property": {
		severity: "warning",
		summary: "A property the format does not define",
		why: "The format accepts unknown properties without saying what LOX does with them, so a misspelled optional field, such as captoin, does not do what was meant and no error says so.",
		fix: "Correct the name if it is a typo; otherwise remove the property or keep it on purpose.",
		basis: SCHEMA,
	},
	"format/not-in-submission": {
		severity: "warning",
		summary:
			"A field of the LOX article format that the submission API does not define",
		why: "The schema describes the article as LOX stores it; the submission API does not list these fields. loxId is assigned by LOX. What LOX does with the others in a submission is not documented.",
		fix: "Remove the field from the submission.",
		basis:
			"LOX technical overview: the schema is the processed article, the API is the submission",
	},
	"media/undeclared-ref": {
		severity: "error",
		summary: "The hero or a media block uses a ref that media does not declare",
		why: "media is the manifest of every media item the hero and body use; LOX cannot fetch an item it does not know.",
		fix: "Add a media declaration with this ref, or correct the ref. Refs are case-sensitive.",
		basis: SCHEMA,
	},
	"media/duplicate-ref": {
		severity: "error",
		summary: "Two media declarations have the same ref",
		why: "Each ref is unique within the article, compared after Unicode NFC normalization.",
		fix: "Remove the second declaration, or give it its own ref.",
		basis: SCHEMA,
	},
	"media/kind-mismatch": {
		severity: "error",
		summary: "A media block points to a declaration of another kind",
		why: "An image block that points to audio cannot be rendered as an image.",
		fix: "Use the block type that matches the declared kind, or correct the ref.",
		basis: CONSISTENCY,
	},
	"media/unused": {
		severity: "warning",
		summary: "A media declaration that neither the hero nor any block uses",
		why: "LOX would fetch or wait for media that the article never shows.",
		fix: "Remove the declaration, or add the block that should show it.",
		basis: CONSISTENCY,
	},
	"media/mime-kind": {
		severity: "warning",
		summary: "The mimeType does not match the declared kind",
		why: "An image declared as video/mp4, for example, is probably a mistake in kind or mimeType. Streaming formats such as application/vnd.apple.mpegurl are a deliberate exception.",
		fix: "Correct kind or mimeType.",
		basis: CONSISTENCY,
	},
	"media/duration-on-image": {
		severity: "warning",
		summary: "An image declaration has durationSeconds",
		why: "durationSeconds is the duration of audio or video.",
		fix: "Remove durationSeconds, or correct the kind.",
		basis: API,
	},
	"delivery/upload-url": {
		severity: "error",
		summary: "Upload delivery with a url",
		why: "For upload delivery, url must be absent: the media is sent through the upload endpoints instead.",
		fix: 'Remove url, or use {"method":"url","url":...} if LOX should fetch the media.',
		basis: API,
	},
	"delivery/internal-url": {
		severity: "error",
		summary: "A delivery url on an internal host",
		why: "LOX refuses internal addresses for url delivery. This catches what the URL shows by itself: private, loopback and link-local addresses, single-label host names and names such as .local.",
		fix: "Use a public URL for the media, or deliver it with upload.",
		basis: API,
	},
	"delivery/upload-incomplete": {
		severity: "error",
		summary: "Upload delivery without byteSize or checksum",
		why: "byteSize and checksum are required for upload delivery.",
		fix: "Add byteSize and checksum of the media file.",
		basis: API,
	},
	"text/markup": {
		severity: "warning",
		summary: "A plain-text field holds an HTML tag or entity",
		why: "Rich text takes no raw HTML; marks, links and lineBreak items carry formatting. A consumer may show <b> or &amp; literally.",
		fix: "Decode entities to their characters and express formatting with marks, links or separate blocks. A run marked code may show markup on purpose.",
		basis: SCHEMA,
	},
	"text/newline": {
		severity: "warning",
		summary: "A line break in a text run or a single-line field",
		why: "Rich text has a lineBreak item for this. How a raw newline shows is up to each consumer, and in titles, headings and labels it is rarely meant.",
		fix: "Use a lineBreak item, start a new block, or replace the line break with a space.",
		basis: SCHEMA,
	},
	"block/blank": {
		severity: "warning",
		summary: "A text block or list item with no visible text",
		why: "Text of only spaces, no-break spaces or line breaks passes the format but shows as an empty gap.",
		fix: "Remove the block or list item.",
		basis: CONSISTENCY,
	},
	"spec/violation": {
		severity: "error",
		summary:
			"The LOX documents in --spec-dir reject what the built-in rules accept",
		why: "The built-in rules follow the tested versions of the documents; the documents given differ or are read differently.",
		fix: "Follow the message. If the documents changed, a new version of this validator may be needed.",
		basis: "The LOX documents given with --spec-dir",
	},
	"spec/changed": {
		severity: "warning",
		summary:
			"The LOX documents differ from the versions this validator was tested with",
		why: "The built-in rules may be out of date; the check against the documents still runs.",
		fix: "Look for a newer version of this validator.",
		basis: "The LOX documents given with --spec-dir",
	},
} satisfies Record<string, Omit<Rule, "id">>;

export type RuleId = keyof typeof CATALOG;

export function getRule(id: RuleId): Rule {
	return { id, ...CATALOG[id] };
}

/** Sorted by id, so that `rules` lists them alphabetically whatever the catalog order. */
export const RULES: readonly Rule[] = (Object.keys(CATALOG) as RuleId[])
	.sort()
	.map(getRule);

export function isRuleId(value: string): value is RuleId {
	return Object.hasOwn(CATALOG, value);
}
