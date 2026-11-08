/**
 * Rules beyond the structure of single values: how parts of an article relate, and mistakes that
 * the format accepts but that lose or garble content.
 */
import { BlockList, isIPv4 } from "node:net";
import { isObject, type JsonObject as Json } from "./json-source.ts";
import {
	MEDIA_KINDS,
	NOT_IN_SUBMISSION,
	show,
	type TextField,
	type UnknownProperty,
} from "./lox-format.ts";
import type { RuleId } from "./types.ts";

export interface Finding {
	ruleId: RuleId;
	pointer: string;
	message: string;
	fix?: string;
	/** Point at the property name instead of its value. */
	atKey?: boolean;
}

/** The items of a list field, or none when it is not a list; the format checks report that. */
const list = (value: unknown): readonly unknown[] =>
	Array.isArray(value) ? value : [];

const MEDIA_BLOCK_TYPES: readonly unknown[] = MEDIA_KINDS;

function refKey(ref: unknown): string | null {
	return typeof ref === "string" ? ref.normalize("NFC") : null;
}

const INTERNAL_NAMES = /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa)$/;

/** Private, shared, loopback, link-local, reserved and multicast IPv4 ranges. */
const INTERNAL_IPV4 = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 3],
] as const;

/** Unspecified, loopback, unique local, link-local, site-local and multicast IPv6 ranges. */
const INTERNAL_IPV6 = [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const;

const INTERNAL = new BlockList();
for (const [network, bits] of INTERNAL_IPV4) {
	// An IPv4 rule also matches the IPv4-mapped form ::ffff:a.b.c.d.
	INTERNAL.addSubnet(network, bits, "ipv4");
	// IPv4-compatible (::/96) and NAT64 (64:ff9b::/96) addresses carry an IPv4 address as well.
	for (const prefix of ["::", "64:ff9b::"]) {
		INTERNAL.addSubnet(`${prefix}${network}`, 96 + bits, "ipv6");
	}
}
for (const [network, bits] of INTERNAL_IPV6) {
	INTERNAL.addSubnet(network, bits, "ipv6");
}

/**
 * Where a public IPv6 address can be: global unicast, or a form that carries an IPv4 address,
 * which INTERNAL judges by that address. Everything else is reserved or local.
 */
const PUBLIC_IPV6 = new BlockList();
PUBLIC_IPV6.addSubnet("2000::", 3, "ipv6");
for (const prefix of ["::ffff:0:0", "::", "64:ff9b::"]) {
	PUBLIC_IPV6.addSubnet(prefix, 96, "ipv6");
}

const internalIpv6 = (address: string): boolean =>
	INTERNAL.check(address, "ipv6") || !PUBLIC_IPV6.check(address, "ipv6");

/**
 * What a delivery URL's host shows by itself to be internal: an address in INTERNAL_IPV4 or
 * INTERNAL_IPV6, an IPv6 address outside the public ranges, a single-label name, or a name
 * reserved for local networks. A public name that resolves to an internal address is beyond what
 * this can see.
 */
export function internalHost(url: string): string | null {
	const host = URL.parse(url)?.hostname;
	if (host === undefined) return null;
	const internal = host.startsWith("[")
		? internalIpv6(host.slice(1, -1))
		: isIPv4(host)
			? INTERNAL.check(host, "ipv4")
			: null;
	if (internal !== null)
		return internal ? `the internal address ${host}` : null;
	const name = host.replace(/\.$/, "");
	if (!name.includes(".")) return `the single-label host ${show(name)}`;
	if (INTERNAL_NAMES.test(name)) return `the local host name ${show(name)}`;
	return null;
}

/** Refs, kinds and delivery: what makes body, hero and media one consistent article. */
export function checkMedia(article: Json): Finding[] {
	const findings: Finding[] = [];
	const media = list(article.media);
	const declared = new Map<
		string,
		{ index: number; kind: unknown; ref: unknown }
	>();

	media.forEach((declaration, index) => {
		if (!isObject(declaration)) return;
		const at = `/media/${index}`;
		const key = refKey(declaration.ref);
		if (key !== null) {
			const first = declared.get(key);
			if (first) {
				findings.push({
					ruleId: "media/duplicate-ref",
					pointer: `${at}/ref`,
					message: `media ref ${show(declaration.ref)} is already declared at /media/${first.index}; refs are compared after Unicode NFC normalization`,
				});
			} else {
				declared.set(key, {
					index,
					kind: declaration.kind,
					ref: declaration.ref,
				});
			}
		}

		const { kind, mimeType, delivery } = declaration;
		if (
			typeof kind === "string" &&
			typeof mimeType === "string" &&
			MEDIA_BLOCK_TYPES.includes(kind) &&
			!mimeType.startsWith(`${kind}/`)
		) {
			findings.push({
				ruleId: "media/mime-kind",
				pointer: `${at}/mimeType`,
				message: `media declaration of kind ${show(kind)} has mimeType ${show(mimeType)}, which is not ${kind}/*`,
			});
		}
		if (kind === "image" && declaration.durationSeconds !== undefined) {
			findings.push({
				ruleId: "media/duration-on-image",
				pointer: `${at}/durationSeconds`,
				message: "an image declaration has durationSeconds",
			});
		}

		if (
			isObject(delivery) &&
			delivery.method === "url" &&
			typeof delivery.url === "string"
		) {
			const internal = internalHost(delivery.url);
			if (internal !== null) {
				findings.push({
					ruleId: "delivery/internal-url",
					pointer: `${at}/delivery/url`,
					message: `delivery url points to ${internal}, which LOX cannot fetch from`,
				});
			}
		}

		if (isObject(delivery) && delivery.method === "upload") {
			if (delivery.url !== undefined) {
				findings.push({
					ruleId: "delivery/upload-url",
					pointer: `${at}/delivery/url`,
					message: "upload delivery has a url, which must be absent",
					atKey: true,
				});
			}
			const missing = ["byteSize", "checksum"].filter(
				(field) => declaration[field] === undefined,
			);
			if (missing.length > 0) {
				findings.push({
					ruleId: "delivery/upload-incomplete",
					pointer: at,
					message: `upload delivery needs ${missing.join(" and ")}, which this declaration lacks`,
				});
			}
		}
	});

	const used = new Set<string>();
	const checkUse = (
		owner: string,
		pointer: string,
		ref: unknown,
		type?: unknown,
	) => {
		const key = refKey(ref);
		if (key === null) return;
		used.add(key);
		const declaration = declared.get(key);
		if (!declaration) {
			findings.push({
				ruleId: "media/undeclared-ref",
				pointer: `${pointer}/ref`,
				message: `${owner} uses ref ${show(ref)}, which has no declaration in media`,
			});
		} else if (
			type !== undefined &&
			MEDIA_BLOCK_TYPES.includes(declaration.kind) &&
			declaration.kind !== type
		) {
			findings.push({
				ruleId: "media/kind-mismatch",
				pointer: `${pointer}/type`,
				message: `${owner} uses ref ${show(ref)}, which is declared with kind ${show(declaration.kind)} at /media/${declaration.index}`,
			});
		}
	};

	if (isObject(article.hero)) checkUse("hero", "/hero", article.hero.ref);
	const body = list(article.body);
	body.forEach((block, index) => {
		if (isObject(block) && MEDIA_BLOCK_TYPES.includes(block.type)) {
			checkUse(`${block.type} block`, `/body/${index}`, block.ref, block.type);
		}
	});

	for (const [key, { index, ref }] of declared) {
		if (used.has(key)) continue;
		findings.push({
			ruleId: "media/unused",
			pointer: `/media/${index}`,
			message: `media ref ${show(ref)} is declared but neither the hero nor a body block uses it`,
		});
	}
	return findings;
}

/** Fields of the article format that a submission does not carry. */
export function checkSubmissionFields(article: Json): Finding[] {
	const findings: Finding[] = [];
	for (const field of NOT_IN_SUBMISSION.root) {
		if (field in article) {
			findings.push({
				ruleId: "format/not-in-submission",
				pointer: `/${field}`,
				message: `${field} belongs to the LOX article format, but the submission API does not define it`,
				atKey: true,
			});
		}
	}
	const media = list(article.media);
	media.forEach((declaration, index) => {
		if (!isObject(declaration)) return;
		for (const field of NOT_IN_SUBMISSION.media) {
			if (field in declaration) {
				findings.push({
					ruleId: "format/not-in-submission",
					pointer: `/media/${index}/${field}`,
					message: `${field} belongs to the LOX article format, but the submission API does not define it for media`,
					atKey: true,
				});
			}
		}
	});
	return findings;
}

/** Edit distance, cut off above 2: only close misspellings are worth suggesting. */
function closeTo(a: string, b: string): boolean {
	if (a.toLowerCase() === b.toLowerCase()) return true;
	if (Math.abs(a.length - b.length) > 2) return false;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				(previous[j] as number) + 1,
				(current[j - 1] as number) + 1,
				(previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return (previous[b.length] as number) <= 2;
}

export function unknownPropertyFinding({
	pointer,
	name,
	known,
	absent,
}: UnknownProperty): Finding {
	const suggestion = absent.find((candidate) => closeTo(name, candidate));
	return {
		ruleId: "format/unknown-property",
		pointer,
		atKey: true,
		message:
			suggestion === undefined
				? `${show(name)} is not a field here; known fields are ${known.join(", ")}`
				: `${show(name)} is not a field here; did you mean ${show(suggestion)}?`,
		...(suggestion === undefined
			? {}
			: { fix: `Rename ${show(name)} to ${show(suggestion)}.` }),
	};
}

const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/;
const HTML_ENTITY =
	/&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
/** Whitespace a reader does not see, including no-break and zero-width spaces. */
const INVISIBLE = /^[\s\u00a0\u200b\u2060\ufeff]*$/u;

function markupIn(text: string): string | null {
	return HTML_TAG.exec(text)?.[0] ?? HTML_ENTITY.exec(text)?.[0] ?? null;
}

/** Leftovers of HTML in plain-text fields, and line breaks a text field cannot hold. */
export function checkText(fields: readonly TextField[]): Finding[] {
	const findings: Finding[] = [];
	for (const field of fields) {
		const markup = field.code ? null : markupIn(field.text);
		if (markup !== null) {
			findings.push({
				ruleId: "text/markup",
				pointer: field.pointer,
				message: `text holds HTML ${show(markup)}, which LOX shows literally`,
			});
		}
		if (field.kind !== "lines" && LINE_BREAK.test(field.text)) {
			const run = field.kind === "run";
			findings.push({
				ruleId: "text/newline",
				pointer: field.pointer,
				message: run
					? "a text run holds a line break; rich text marks one with a lineBreak item"
					: "a single-line text field holds a line break",
				fix: run
					? 'Split the run and put {"type":"lineBreak"} between the parts, or start a new paragraph.'
					: "Replace the line break with a space.",
			});
		}
	}
	return findings;
}

function visibleText(inlines: unknown): boolean {
	if (!Array.isArray(inlines)) return true;
	return inlines.some((inline) => {
		if (!isObject(inline)) return true;
		if (inline.type === "text")
			return typeof inline.text !== "string" || !INVISIBLE.test(inline.text);
		if (inline.type === "link") return visibleText(inline.children);
		return inline.type !== "lineBreak";
	});
}

/** Rich text with items, none of which shows anything. */
const blankInlines = (inlines: unknown): boolean =>
	Array.isArray(inlines) && inlines.length > 0 && !visibleText(inlines);

/** Text blocks with no visible text: a paragraph of no-break spaces, a list item of spaces. */
export function checkBlankBlocks(article: Json): Finding[] {
	const findings: Finding[] = [];
	const body = list(article.body);
	body.forEach((block, index) => {
		if (!isObject(block)) return;
		const at = `/body/${index}`;
		if (
			(block.type === "paragraph" || block.type === "quote") &&
			blankInlines(block.content)
		) {
			findings.push({
				ruleId: "block/blank",
				pointer: at,
				message: `${block.type} block has no visible text`,
			});
		}
		if (
			block.type === "heading" &&
			typeof block.text === "string" &&
			block.text !== "" &&
			INVISIBLE.test(block.text)
		) {
			findings.push({
				ruleId: "block/blank",
				pointer: at,
				message: "heading block has no visible text",
			});
		}
		if (block.type === "list") {
			list(block.items).forEach((item, itemIndex) => {
				if (blankInlines(item)) {
					findings.push({
						ruleId: "block/blank",
						pointer: `${at}/items/${itemIndex}`,
						message: "list item has no visible text",
					});
				}
			});
		}
	});
	return findings;
}
