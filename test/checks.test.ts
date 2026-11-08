import { describe, expect, test } from "bun:test";
import {
	checkBlankBlocks,
	checkMedia,
	checkSubmissionFields,
	checkText,
	type Finding,
	internalHost,
	unknownPropertyFinding,
} from "../src/checks.ts";
import { pointerPath } from "../src/json-source.ts";
import { checkFormat } from "../src/lox-format.ts";
import type { RuleId } from "../src/types.ts";
import {
	DIGESTS,
	example,
	full,
	type Json,
	lineBreak,
	link,
	minimal,
	paragraph,
	text,
	urlDelivery,
	variant,
} from "./fixtures.ts";

const textOf = (article: unknown) => checkText(checkFormat(article).text);

const only = (findings: Finding[], ruleId: RuleId) =>
	findings.filter((finding) => finding.ruleId === ruleId);
const pointers = (findings: Finding[], ruleId: RuleId) =>
	only(findings, ruleId).map((finding) => finding.pointer);

/** Each finding as "ruleId at pointer". */
const found = (findings: Finding[]) =>
	findings.map((finding) => `${finding.ruleId} at ${finding.pointer}`);

const setAt = (article: Json, pointer: string, value: unknown) => {
	const path = pointerPath(pointer);
	const last = path.pop() as string;
	let owner = article;
	for (const segment of path) owner = owner[segment];
	owner[last] = value;
};

const declaration = (ref: string, extra: object = {}) => ({
	ref,
	kind: "image",
	mimeType: "image/jpeg",
	delivery: urlDelivery(),
	...extra,
});
/** A submission with these media declarations and blocks, and an optional hero. */
const withMedia = (
	media: unknown[],
	blocks: unknown[],
	hero?: object,
): Json => ({
	...minimal(),
	media,
	body: [paragraph(), ...blocks],
	...(hero === undefined ? {} : { hero }),
});
/** The findings for one declaration with these fields, which the hero uses. */
const declared = (fields: object) =>
	checkMedia(withMedia([declaration("m", fields)], [], { ref: "m" }));

test("the fixtures give no findings at all", () => {
	for (const article of [example(), full(), minimal()]) {
		expect(checkMedia(article)).toEqual([]);
		expect(checkSubmissionFields(article)).toEqual([]);
		expect(textOf(article)).toEqual([]);
		expect(checkBlankBlocks(article)).toEqual([]);
	}
});

describe("media refs", () => {
	test("an undeclared ref in a block", () => {
		const findings = checkMedia(
			withMedia([], [{ type: "image", ref: "a.jpg" }]),
		);
		expect(findings).toEqual([
			{
				ruleId: "media/undeclared-ref",
				pointer: "/body/1/ref",
				message:
					'image block uses ref "a.jpg", which has no declaration in media',
			},
		]);
	});

	test("an undeclared ref in the hero", () => {
		expect(
			pointers(
				checkMedia(withMedia([], [], { ref: "a.jpg" })),
				"media/undeclared-ref",
			),
		).toEqual(["/hero/ref"]);
	});

	test("refs are case-sensitive", () => {
		const findings = checkMedia(
			withMedia(
				[declaration("Foto.jpg")],
				[{ type: "image", ref: "foto.jpg" }],
			),
		);
		expect(pointers(findings, "media/undeclared-ref")).toEqual(["/body/1/ref"]);
		expect(pointers(findings, "media/unused")).toEqual(["/media/0"]);
	});

	test("refs equal after NFC normalization are the same ref", () => {
		const composed = "café.jpg";
		const decomposed = "café.jpg";
		expect(
			checkMedia(
				withMedia(
					[declaration(composed)],
					[{ type: "image", ref: decomposed }],
				),
			),
		).toEqual([]);
		expect(
			checkMedia(withMedia([declaration(decomposed)], [], { ref: composed })),
		).toEqual([]);
	});

	test("a duplicate ref, exact or after NFC", () => {
		for (const second of ["aé.jpg", "aé.jpg"]) {
			const findings = checkMedia(
				withMedia(
					[declaration("aé.jpg"), declaration(second)],
					[{ type: "image", ref: "aé.jpg" }],
				),
			);
			expect(findings).toEqual([
				{
					ruleId: "media/duplicate-ref",
					pointer: "/media/1/ref",
					message: expect.stringContaining("already declared at /media/0"),
				},
			]);
		}
	});

	test("refs that differ only in case are no duplicates", () => {
		const findings = checkMedia(
			withMedia(
				[declaration("a.jpg"), declaration("A.jpg")],
				[
					{ type: "image", ref: "a.jpg" },
					{ type: "image", ref: "A.jpg" },
				],
			),
		);
		expect(findings).toEqual([]);
	});

	test("a declaration used by the hero alone is used", () => {
		expect(
			checkMedia(withMedia([declaration("a.jpg")], [], { ref: "a.jpg" })),
		).toEqual([]);
	});

	test("a declaration nobody uses", () => {
		const findings = checkMedia(withMedia([declaration("a.jpg")], []));
		expect(findings).toEqual([
			{
				ruleId: "media/unused",
				pointer: "/media/0",
				message: expect.stringContaining('"a.jpg"'),
			},
		]);
	});

	test("a ref only used by a non-media block does not count as use", () => {
		const findings = checkMedia(
			withMedia(
				[declaration("a.jpg")],
				[{ type: "embed", url: "https://x.nl", ref: "a.jpg" }],
			),
		);
		expect(pointers(findings, "media/unused")).toEqual(["/media/0"]);
	});

	test("non-string refs and non-object entries are skipped without findings", () => {
		const article = withMedia(
			[null, "x", 3, declaration("a.jpg"), { ref: 5, kind: "image" }],
			[{ type: "image", ref: 7 }, "x", null, { type: "image", ref: "a.jpg" }],
			{ ref: null },
		);
		expect(checkMedia(article)).toEqual([]);
	});

	test("missing or broken media and body arrays do not throw", () => {
		for (const article of [{}, { media: "x", body: {} }, { hero: "x" }]) {
			expect(checkMedia(article)).toEqual([]);
			expect(textOf(article)).toEqual([]);
			expect(checkBlankBlocks(article)).toEqual([]);
			expect(checkSubmissionFields(article)).toEqual([]);
		}
	});
});

describe("media kinds", () => {
	const audio = declaration("a.mp3", { kind: "audio", mimeType: "audio/mpeg" });

	test("a block of another kind than its declaration", () => {
		expect(
			checkMedia(withMedia([audio], [{ type: "image", ref: "a.mp3" }])),
		).toEqual([
			{
				ruleId: "media/kind-mismatch",
				pointer: "/body/1/type",
				message:
					'image block uses ref "a.mp3", which is declared with kind "audio" at /media/0',
			},
		]);
	});

	test("every pair of kinds is checked", () => {
		for (const kind of ["image", "video", "audio"]) {
			for (const type of ["image", "video", "audio"]) {
				const findings = checkMedia(
					withMedia(
						[declaration("m", { kind, mimeType: `${kind}/x` })],
						[{ type, ref: "m" }],
					),
				);
				expect(only(findings, "media/kind-mismatch")).toHaveLength(
					kind === type ? 0 : 1,
				);
			}
		}
	});

	test("the hero may use any kind", () => {
		expect(checkMedia(withMedia([audio], [], { ref: "a.mp3" }))).toEqual([]);
	});

	test("a declaration of an unknown kind gives no kind mismatch", () => {
		const findings = checkMedia(
			withMedia(
				[declaration("a", { kind: "pdf" })],
				[{ type: "image", ref: "a" }],
			),
		);
		expect(findings).toEqual([]);
	});

	test("the first of two duplicate declarations decides the kind", () => {
		const findings = checkMedia(
			withMedia(
				[
					declaration("m", { kind: "video", mimeType: "video/mp4" }),
					declaration("m"),
				],
				[{ type: "video", ref: "m" }],
			),
		);
		expect(findings.map((finding) => finding.ruleId)).toEqual([
			"media/duplicate-ref",
		]);
	});
});

describe("mime types", () => {
	const MIME_KIND = "media/mime-kind at /media/0/mimeType";
	const DURATION = "media/duration-on-image at /media/0/durationSeconds";

	test("a type of another kind gives the warning at mimeType", () => {
		expect(declared({ kind: "image", mimeType: "video/mp4" })).toEqual([
			{
				ruleId: "media/mime-kind",
				pointer: "/media/0/mimeType",
				message:
					'media declaration of kind "image" has mimeType "video/mp4", which is not image/*',
			},
		]);
	});

	for (const [name, fields, expected] of [
		["a matching image type", { kind: "image", mimeType: "image/png" }, []],
		["a matching video type", { kind: "video", mimeType: "video/mp4" }, []],
		["a matching audio type", { kind: "audio", mimeType: "audio/ogg" }, []],
		[
			"a video type on audio",
			{ kind: "audio", mimeType: "video/mp4" },
			[MIME_KIND],
		],
		[
			"a streaming type on video",
			{ kind: "video", mimeType: "application/vnd.apple.mpegurl" },
			[MIME_KIND],
		],
		[
			"a streaming type on audio",
			{ kind: "audio", mimeType: "application/x-mpegurl" },
			[MIME_KIND],
		],
		[
			"a prefix that is not the full type",
			{ kind: "image", mimeType: "imagex/png" },
			[MIME_KIND],
		],
		["an unknown kind", { kind: "pdf", mimeType: "application/pdf" }, []],
		["a non-string mimeType", { mimeType: 5 }, []],
		[
			"durationSeconds on an image",
			{ kind: "image", mimeType: "image/x", durationSeconds: 3 },
			[DURATION],
		],
		[
			"durationSeconds on a video",
			{ kind: "video", mimeType: "video/x", durationSeconds: 3 },
			[],
		],
		[
			"durationSeconds on audio",
			{ kind: "audio", mimeType: "audio/x", durationSeconds: 3 },
			[],
		],
	] as const) {
		test(name, () => {
			expect(found(declared(fields))).toEqual([...expected]);
		});
	}
});

describe("upload delivery", () => {
	const UPLOAD = { method: "upload" };
	const UPLOAD_URL = "delivery/upload-url at /media/0/delivery/url";
	const complete = {
		byteSize: 10,
		checksum: { algorithm: "sha256", value: DIGESTS.sha256 },
	};

	test("a url on upload delivery points at the url key", () => {
		expect(
			declared({
				...complete,
				delivery: { ...UPLOAD, url: "https://x.nl/a.jpg" },
			}),
		).toEqual([
			{
				ruleId: "delivery/upload-url",
				pointer: "/media/0/delivery/url",
				message: "upload delivery has a url, which must be absent",
				atKey: true,
			},
		]);
	});

	test("missing byteSize, checksum or both", () => {
		const lacking = (extra: object) =>
			only(
				declared({ ...extra, delivery: UPLOAD }),
				"delivery/upload-incomplete",
			).map((finding) => [finding.pointer, finding.message]);
		const needs = (fields: string) => [
			[
				"/media/0",
				`upload delivery needs ${fields}, which this declaration lacks`,
			],
		];
		expect(lacking({})).toEqual(needs("byteSize and checksum"));
		expect(lacking({ byteSize: 1 })).toEqual(needs("checksum"));
		expect(lacking({ checksum: complete.checksum })).toEqual(needs("byteSize"));
	});

	for (const [name, fields, expected] of [
		["complete upload delivery", { ...complete, delivery: UPLOAD }, []],
		[
			"an empty url on upload delivery",
			{ ...complete, delivery: { ...UPLOAD, url: "" } },
			[UPLOAD_URL],
		],
		[
			"a null url on upload delivery",
			{ ...complete, delivery: { ...UPLOAD, url: null } },
			[UPLOAD_URL],
		],
		[
			"url delivery without byteSize and checksum",
			{ delivery: urlDelivery() },
			[],
		],
		["an unknown method", { delivery: { method: "s3", url: "x" } }, []],
		["no method", { delivery: { url: "x" } }, []],
	] as const) {
		test(name, () => {
			expect(found(declared(fields))).toEqual([...expected]);
		});
	}
});

describe("internal delivery urls", () => {
	const internal = [
		"http://10.0.0.1/a.jpg",
		"http://10.255.255.255/",
		"http://127.0.0.1/",
		"http://127.1/",
		"http://2130706433/",
		"http://0x7f.1/",
		"http://017700000001/",
		"http://0.0.0.0/",
		"http://169.254.169.254/latest/meta-data",
		"http://172.16.0.1/",
		"http://172.31.255.255/",
		"http://192.168.1.10/",
		"http://192.0.0.8/",
		"http://100.64.0.1/",
		"http://100.127.255.255/",
		"http://198.18.0.1/",
		"http://198.19.255.255/",
		"http://224.0.0.1/",
		"http://255.255.255.255/",
		"http://user:secret@10.0.0.1/",
		"http://10.0.0.1./",
		"https://10.0.0.1:8443/a.jpg",
		"http://[::1]/",
		"http://[::]/",
		"http://[0:0:0:0:0:0:0:1]/",
		"http://[fc00::1]/",
		"http://[fd12:3456::1]/",
		"http://[fe80::1]/",
		"http://[febf::1]/",
		"http://[::ffff:10.0.0.1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:192.168.1.1]/",
		"http://[::ffff:169.254.169.254]/",
		// Short first groups: 00fc::, 00ff::, 0fe8:: and 0fec:: lie outside global unicast.
		"http://[fc::1]/",
		"http://[fd::1]/",
		"http://[ff::1]/",
		"http://[fe8::1]/",
		"http://[fec::1]/",
		"http://[4000::1]/",
		"http://[::2]/",
		"http://localhost/",
		"http://localhost./",
		"http://LOCALHOST/",
		"http://intranet/a.jpg",
		"http://media/a.jpg",
		"http://foo.localhost/",
		"http://nas.local/",
		"http://cms.internal/",
		"http://pc.lan/",
		"http://router.home.arpa/",
		"http://home.arpa/",
	];
	const external = [
		"https://www.example.nl/a.jpg",
		"https://example.com./a.jpg",
		"http://172.15.255.255/",
		"http://172.32.0.1/",
		"http://100.63.255.255/",
		"http://100.128.0.1/",
		"http://169.253.0.1/",
		"http://192.169.0.1/",
		"http://198.17.0.1/",
		"http://198.20.0.1/",
		"http://223.255.255.255/",
		"http://1.1.1.1/",
		"http://8.8.8.8/",
		"http://11.0.0.1/",
		"http://[2001:4860:4860::8888]/",
		"http://[::ffff:8.8.8.8]/",
		"http://[::8.8.8.8]/",
		"http://[64:ff9b::8.8.8.8]/",
		"http://[2a00:1450:4013::1]/",
		"http://[3fff::1]/",
		"http://notlocal.com/",
		"http://local.example.nl/",
		"http://internal.example.nl/",
		"http://localhost.example.nl/",
		"http://lan.example.nl/",
		"http://cdn.example.nl:8080/a.jpg",
	];

	for (const url of internal) {
		test(`${url} is internal`, () => {
			expect(internalHost(url)).not.toBeNull();
		});
	}
	for (const url of external) {
		test(`${url} is not internal`, () => {
			expect(internalHost(url)).toBeNull();
		});
	}

	// URL parsing rewrites [::ffff:192.0.2.1] to [::ffff:c000:201]; all four octets must survive.
	test("an IPv4-mapped address is judged like the IPv4 address itself", () => {
		for (const ipv4 of ["192.0.2.1", "192.0.1.5", "8.8.8.8", "10.1.2.3"]) {
			expect(internalHost(`http://[::ffff:${ipv4}]/`) === null).toBe(
				internalHost(`http://${ipv4}/`) === null,
			);
		}
	});

	test("the reason names the normalised address or the host name", () => {
		expect(internalHost("http://2130706433/")).toBe(
			"the internal address 127.0.0.1",
		);
		expect(internalHost("http://[::1]/")).toBe("the internal address [::1]");
		expect(internalHost("http://intranet/")).toBe(
			'the single-label host "intranet"',
		);
		expect(internalHost("http://nas.local/")).toBe(
			'the local host name "nas.local"',
		);
	});

	test("text that is no URL gives nothing", () => {
		for (const url of ["", "not a url", "https://", "//10.0.0.1/"]) {
			expect(internalHost(url)).toBeNull();
		}
	});

	test("checkMedia reports it at the delivery url, for url delivery only", () => {
		const findings = (delivery: object) =>
			only(declared({ delivery }), "delivery/internal-url");
		expect(findings(urlDelivery("http://192.168.1.10/a.jpg"))).toEqual([
			{
				ruleId: "delivery/internal-url",
				pointer: "/media/0/delivery/url",
				message:
					"delivery url points to the internal address 192.168.1.10, which LOX cannot fetch from",
			},
		]);
		expect(findings(urlDelivery())).toEqual([]);
		expect(findings({ method: "upload", url: "http://10.0.0.1/" })).toEqual([]);
		expect(findings({ method: "url", url: 5 })).toEqual([]);
	});

	test("other URLs in the article are not checked for internal hosts", () => {
		const article = variant(full(), (a) => {
			a.metadata.canonicalUrl = "http://localhost/";
			a.body[9].url = "http://10.0.0.1/";
		});
		expect(only(checkMedia(article), "delivery/internal-url")).toEqual([]);
	});
});

describe("fields outside the submission", () => {
	test("each root field and sourceIds point at their key", () => {
		const findings = checkSubmissionFields(
			variant(full(), (a) => {
				a.formatVersion = "1.0";
				a.contentType = "article";
				a.loxId = "x";
				a.extensions = {};
				a.media[2].sourceIds = [];
			}),
		);
		expect(findings.map((finding) => [finding.pointer, finding.atKey])).toEqual(
			[
				["/formatVersion", true],
				["/contentType", true],
				["/loxId", true],
				["/extensions", true],
				["/media/2/sourceIds", true],
			],
		);
		for (const finding of findings) {
			expect(finding.ruleId).toBe("format/not-in-submission");
		}
	});

	test("a null value still counts as present", () => {
		expect(checkSubmissionFields({ ...minimal(), loxId: null })).toHaveLength(
			1,
		);
	});
});

describe("unknown-property suggestions", () => {
	const finding = (name: string, present: string[] = []) =>
		unknownPropertyFinding({
			pointer: `/hero/${name}`,
			name,
			known: ["ref", "caption"],
			absent: ["ref", "caption"].filter((field) => !present.includes(field)),
		});

	test("a close misspelling of an absent field is suggested", () => {
		expect(finding("captoin")).toEqual({
			ruleId: "format/unknown-property",
			pointer: "/hero/captoin",
			atKey: true,
			message: '"captoin" is not a field here; did you mean "caption"?',
			fix: 'Rename "captoin" to "caption".',
		});
	});

	test("no suggestion when the suggested field is already present", () => {
		const result = finding("captoin", ["caption"]);
		expect(result.message).toBe(
			'"captoin" is not a field here; known fields are ref, caption',
		);
		expect(result.fix).toBeUndefined();
	});

	test("a different case is always close", () => {
		expect(finding("CAPTION").fix).toBe('Rename "CAPTION" to "caption".');
	});

	test("two edits are close, three are not", () => {
		expect(finding("captn").fix).toBeDefined();
		expect(finding("cptn").fix).toBeUndefined();
		expect(finding("refs").fix).toBe('Rename "refs" to "ref".');
		expect(finding("source").fix).toBeUndefined();
	});

	test("a very long name gets no suggestion and is cheap", () => {
		expect(finding("c".repeat(100_000)).fix).toBeUndefined();
	});
});

describe("text/markup", () => {
	const markup = (change: (article: Json) => void) =>
		pointers(textOf(variant(full(), change)), "text/markup");

	for (const sample of [
		"<b>vet</b>",
		"<br>",
		"<br/>",
		"<br />",
		"</p>",
		'<a href="x">',
		"<my-element>",
		"&amp;",
		"&nbsp;",
		"&#39;",
		"&#x27;",
		"&#X27;",
	]) {
		test(`${sample} is markup`, () => {
			expect(
				markup((a) => {
					a.body[0].content[0].text = `a ${sample} b`;
				}),
			).toEqual(["/body/0/content/0/text"]);
		});
	}

	for (const sample of [
		"a < b > c",
		"<3",
		"x<y",
		"R&D",
		"AT&T",
		"&T;",
		"& amp;",
		"&#;",
		"&#xZZ;",
		"1 < 2 && 3 > 2",
		"<>",
		"< b>",
	]) {
		test(`${sample} is no markup`, () => {
			expect(
				markup((a) => {
					a.body[0].content[0].text = sample;
				}),
			).toEqual([]);
		});
	}

	test("the message shows the markup found", () => {
		const [finding] = textOf({ ...minimal(), title: "Kop &amp; staart" });
		expect(finding?.message).toBe(
			'text holds HTML "&amp;", which LOX shows literally',
		);
	});

	test("the copyright fields of the article and of media are text fields too", () => {
		expect(
			markup((a) => {
				a.metadata.rights.copyrightHolder = "Omroep &amp; Co";
				a.metadata.rights.copyrightNotice = "<b>©</b> Omroep";
				a.media[0].rights.copyrightHolder = "&copy; Fotograaf";
			}).sort(),
		).toEqual([
			"/media/0/rights/copyrightHolder",
			"/metadata/rights/copyrightHolder",
			"/metadata/rights/copyrightNotice",
		]);
	});

	test("a run marked code may hold markup; an unmarked or differently marked one not", () => {
		expect(
			markup((a) => {
				a.body[0].content[4].text = "<div>";
			}),
		).toEqual([]);
		expect(
			markup((a) => {
				a.body[0].content[4] = text("<div>", ["bold"]);
			}),
		).toEqual(["/body/0/content/4/text"]);
	});

	test("every plain-text field is checked", () => {
		const found = markup((a) => {
			const tag = "<i>x</i>";
			a.title = tag;
			a.summary = tag;
			a.hero.caption = tag;
			a.body[0].content[3].children[0].text = tag;
			a.body[1].text = tag;
			a.body[3].caption = tag;
			a.body[6].items[1][0].children[0].text = tag;
			a.body[6].items[0][0].text = tag;
			a.body[8].content[0].text = tag;
			a.body[8].attribution = tag;
			a.body[9].provider = tag;
			a.body[9].title = tag;
			a.media[0].title = tag;
			a.media[0].description = tag;
			a.media[0].credit = tag;
			a.metadata.authors[0].name = tag;
			a.metadata.authors[0].role = tag;
			a.metadata.authors[0].affiliation = tag;
			a.metadata.classifications[0].label = tag;
		});
		expect(found.sort()).toEqual(
			[
				"/title",
				"/summary",
				"/hero/caption",
				"/body/0/content/3/children/0/text",
				"/body/1/text",
				"/body/3/caption",
				"/body/6/items/1/0/children/0/text",
				"/body/6/items/0/0/text",
				"/body/8/content/0/text",
				"/body/8/attribution",
				"/body/9/provider",
				"/body/9/title",
				"/media/0/title",
				"/media/0/description",
				"/media/0/credit",
				"/metadata/authors/0/name",
				"/metadata/authors/0/role",
				"/metadata/authors/0/affiliation",
				"/metadata/classifications/0/label",
			].sort(),
		);
	});

	test("identifiers, refs and URLs are not text", () => {
		expect(
			markup((a) => {
				a.externalId = "<b>";
				a.hero.ref = "<b>";
				a.metadata.canonicalUrl = "https://x.nl/?a=&amp;";
				a.body[9].url = "https://x.nl/<b>";
			}),
		).toEqual([]);
	});
});

describe("text/newline", () => {
	const newlines = (change: (article: Json) => void) =>
		only(textOf(variant(full(), change)), "text/newline");
	const RUN =
		"a text run holds a line break; rich text marks one with a lineBreak item";
	const LINE = "a single-line text field holds a line break";

	test("a line break in a text run asks for a lineBreak item", () => {
		expect(
			newlines((a) => {
				a.body[0].content[0].text = "a\nb";
			}),
		).toEqual([
			{
				ruleId: "text/newline",
				pointer: "/body/0/content/0/text",
				message: RUN,
				fix: 'Split the run and put {"type":"lineBreak"} between the parts, or start a new paragraph.',
			},
		]);
	});

	test("a line break in the title is a single-line field problem", () => {
		expect(
			newlines((a) => {
				a.title = "a\nb";
			}),
		).toEqual([
			{
				ruleId: "text/newline",
				pointer: "/title",
				message: LINE,
				fix: "Replace the line break with a space.",
			},
		]);
	});

	// Text put at these pointers of the full fixture, and the message each must give, or null for
	// no finding at all.
	for (const [name, values, message] of [
		["a run in a link", { "/body/0/content/3/children/0/text": "a\nb" }, RUN],
		["a run in a list item", { "/body/6/items/0/0/text": "a\nb" }, RUN],
		["a line feed in a heading", { "/body/1/text": "a\nb" }, LINE],
		["a carriage return in a heading", { "/body/1/text": "a\rb" }, LINE],
		["CR LF in a heading", { "/body/1/text": "a\r\nb" }, LINE],
		["a line separator in a heading", { "/body/1/text": "a\u2028b" }, LINE],
		[
			"a paragraph separator in a heading",
			{ "/body/1/text": "a\u2029b" },
			LINE,
		],
		[
			"a tab and a next-line character",
			{ "/body/1/text": "a\tb\u0085c" },
			null,
		],
		[
			"summary, captions and descriptions",
			{
				"/summary": "a\nb",
				"/hero/caption": "a\nb",
				"/body/3/caption": "a\r\nb",
				"/media/0/description": "a\nb",
			},
			null,
		],
		[
			"every other single-line field",
			{
				"/body/8/attribution": "a\nb",
				"/body/9/provider": "a\nb",
				"/body/9/title": "a\nb",
				"/media/0/title": "a\nb",
				"/media/0/credit": "a\nb",
				"/metadata/authors/0/name": "a\nb",
				"/metadata/classifications/0/label": "a\nb",
			},
			LINE,
		],
	] as const) {
		test(name, () => {
			const article = full();
			for (const [pointer, value] of Object.entries(values))
				setAt(article, pointer, value);
			const actual = only(textOf(article), "text/newline").map((finding) => [
				finding.pointer,
				finding.message,
			]);
			const expected =
				message === null
					? []
					: Object.keys(values).map((pointer) => [pointer, message]);
			expect(actual.sort()).toEqual(expected.sort());
		});
	}

	test("one field with markup and a line break gives both findings", () => {
		const findings = textOf({ ...minimal(), title: "<b>a\nb</b>" });
		expect(findings.map((finding) => finding.ruleId).sort()).toEqual([
			"text/markup",
			"text/newline",
		]);
	});
});

describe("block/blank", () => {
	const blank = (...blocks: object[]) =>
		checkBlankBlocks({ ...minimal(), body: blocks }).map((finding) => [
			finding.pointer,
			finding.message,
		]);

	test("a paragraph of no-break spaces", () => {
		expect(blank(paragraph(text(" ")))).toEqual([
			["/body/0", "paragraph block has no visible text"],
		]);
	});

	for (const [name, value] of [
		["spaces", "   "],
		["a tab", "\t"],
		["a zero-width space", "​"],
		["a word joiner", "⁠"],
		["a byte order mark", "﻿"],
		["an ideographic space", "　"],
		["a line feed", "\n"],
	] as const) {
		test(`a paragraph of ${name}`, () => {
			expect(blank(paragraph(text(value)))).toHaveLength(1);
		});
	}

	test("a paragraph of only line breaks", () => {
		expect(blank(paragraph(lineBreak()))).toHaveLength(1);
		expect(blank(paragraph(lineBreak(), text(" "), lineBreak()))).toHaveLength(
			1,
		);
	});

	test("a paragraph whose only text is a blank link", () => {
		expect(blank(paragraph(link([text(" ")])))).toHaveLength(1);
	});

	test("visible text anywhere makes the block visible", () => {
		expect(blank(paragraph(text(" "), text("x")))).toEqual([]);
		expect(blank(paragraph(lineBreak(), link([text(" "), text(".")])))).toEqual(
			[],
		);
		expect(blank(paragraph(text(" x ")))).toEqual([]);
	});

	test("a quote is checked like a paragraph", () => {
		expect(
			blank({ type: "quote", content: [text(" ")], attribution: "x" }),
		).toEqual([["/body/0", "quote block has no visible text"]]);
	});

	test("a blank heading", () => {
		expect(blank({ type: "heading", level: 2, text: "  " })).toEqual([
			["/body/0", "heading block has no visible text"],
		]);
		expect(blank({ type: "heading", level: 2, text: "Kop" })).toEqual([]);
	});

	test("blank list items, each at its own pointer", () => {
		expect(
			blank({
				type: "list",
				style: "ordered",
				items: [[text("een")], [text(" ")], [lineBreak()], [text("x")]],
			}),
		).toEqual([
			["/body/0/items/1", "list item has no visible text"],
			["/body/0/items/2", "list item has no visible text"],
		]);
	});

	test("empty content is a format violation, not a blank block", () => {
		expect(blank({ type: "paragraph", content: [] })).toEqual([]);
		expect(blank({ type: "heading", level: 2, text: "" })).toEqual([]);
		expect(blank({ type: "list", style: "ordered", items: [[]] })).toEqual([]);
		expect(blank(paragraph(text("")))).toHaveLength(1);
	});

	test("content it cannot read counts as visible", () => {
		expect(blank(paragraph({ type: "image" }))).toEqual([]);
		expect(blank(paragraph(text(5 as unknown as string)))).toEqual([]);
		expect(blank(paragraph("x" as unknown as object))).toEqual([]);
		expect(blank({ type: "paragraph", content: "  " })).toEqual([]);
	});

	test("media and embed blocks are never blank", () => {
		expect(
			blank(
				{ type: "image", ref: " " },
				{ type: "embed", url: " ", title: " " },
			),
		).toEqual([]);
	});
});
