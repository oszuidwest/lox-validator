/** Valid submissions to start tests from, and small helpers shared by the test files. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: tests mutate arbitrary JSON freely
export type Json = any;

const EXAMPLE_PATH = resolve(import.meta.dir, "../examples/article.json");
export const EXAMPLE_TEXT = readFileSync(EXAMPLE_PATH, "utf8");

/** A fresh copy of examples/article.json. */
export const example = (): Json => JSON.parse(EXAMPLE_TEXT);

export const text = (value = "tekst", marks?: string[]) =>
	marks === undefined
		? { type: "text", text: value }
		: { type: "text", text: value, marks };
export const lineBreak = () => ({ type: "lineBreak" });
export const link = (children: object[] = [text()]) => ({
	type: "link",
	href: "https://www.example.nl/a",
	children,
});
export const paragraph = (...content: object[]) => ({
	type: "paragraph",
	content: content.length === 0 ? [text()] : content,
});

export const DIGESTS = {
	md5: "0123456789abcdef0123456789abcdef",
	sha1: "0123456789abcdef0123456789abcdef01234567",
	sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
} as const;

export const urlDelivery = (url = "https://www.example.nl/media/a.jpg") => ({
	method: "url",
	url,
});

/** A minimal valid submission: one paragraph, no media. */
export const minimal = (): Json => ({
	externalId: "artikel-1",
	metadata: {
		publicationStatus: "published",
		locale: "nl",
		timestamps: { updatedAt: "2026-11-07T10:00:00+01:00" },
	},
	title: "Titel",
	body: [paragraph()],
	media: [],
});

/**
 * A valid submission that uses every block type, inline type, mark, delivery method, checksum
 * algorithm and every optional field of the submission API.
 */
export const full = (): Json => ({
	externalId: "artikel-1",
	metadata: {
		publicationStatus: "published",
		locale: "nl-NL",
		timestamps: {
			createdAt: "2026-11-06T08:00:00Z",
			publishedAt: "2026-11-07T09:30:00+01:00",
			updatedAt: "2026-11-07T10:05:00.250+01:00",
		},
		canonicalUrl: "https://www.example.nl/nieuws/1/",
		authors: [
			{
				name: "Redactie",
				role: "Verslaggever",
				affiliation: "Omroep",
				sourceId: "author-7",
			},
		],
		classifications: [
			{ dimension: "category", id: "cat-1", label: "Nieuws" },
			{ dimension: "location", label: "Roosendaal" },
			{ dimension: "dossier", label: "Brug" },
			{ dimension: "theme", label: "Verkeer" },
			{ dimension: "topic", label: "Fiets" },
			{ dimension: "tag", label: "kanaal" },
		],
		rights: {
			distribution: "permitted",
			licence: { id: "CC-BY-4.0", url: "https://creativecommons.org/l/" },
			copyrightHolder: "Omroep",
			copyrightNotice: "© Omroep",
		},
	},
	title: "Nieuwe brug open",
	summary: "Fietsers kunnen vanaf vandaag over de brug.\nMeer volgt.",
	hero: { ref: "hero.jpg", caption: "De brug" },
	body: [
		{
			type: "paragraph",
			content: [
				text("De brug is "),
				text("open", ["bold", "italic"]),
				lineBreak(),
				link([text("lees meer"), text(" hier", ["underline"])]),
				text("code", ["code"]),
			],
		},
		{ type: "heading", level: 2, text: "Wat verandert er?" },
		{ type: "heading", level: 6, text: "Klein kopje" },
		{ type: "image", ref: "foto.png", caption: "Een foto" },
		{ type: "video", ref: "film.mp4", caption: "Een film" },
		{ type: "audio", ref: "geluid.mp3" },
		{
			type: "list",
			style: "ordered",
			items: [[text("een")], [link(), lineBreak(), text("twee")]],
		},
		{
			type: "list",
			style: "unordered",
			items: [[text("x", ["strikethrough", "subscript", "superscript"])]],
		},
		{
			type: "quote",
			content: [text("Hier hebben we op gewacht.")],
			attribution: "Een omwonende",
		},
		{
			type: "embed",
			url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
			provider: "YouTube",
			title: "Video",
		},
	],
	media: [
		{
			ref: "hero.jpg",
			kind: "image",
			mimeType: "image/jpeg",
			title: "Brug",
			description: "De brug bij de opening",
			credit: "Foto: Redactie",
			width: 1920,
			height: 1080,
			rights: { distribution: "restricted", licence: { id: "eigen" } },
			delivery: urlDelivery("https://www.example.nl/media/hero.jpg"),
		},
		{
			ref: "foto.png",
			kind: "image",
			mimeType: "image/png",
			byteSize: 1234,
			checksum: { algorithm: "md5", value: DIGESTS.md5 },
			delivery: { method: "upload" },
		},
		{
			ref: "film.mp4",
			kind: "video",
			mimeType: "video/mp4",
			width: 1280,
			height: 720,
			durationSeconds: 90,
			byteSize: 5_000_000,
			checksum: { algorithm: "sha1", value: DIGESTS.sha1 },
			delivery: { method: "upload" },
		},
		{
			ref: "geluid.mp3",
			kind: "audio",
			mimeType: "audio/mpeg",
			durationSeconds: 31536000,
			byteSize: 9007199254740991,
			checksum: { algorithm: "sha256", value: DIGESTS.sha256 },
			delivery: urlDelivery("http://media.example.nl/geluid.mp3"),
		},
	],
});

/** Returns a modified copy of `base`. */
export const variant = (base: Json, change: (article: Json) => void): Json => {
	const copy = structuredClone(base);
	change(copy);
	return copy;
};

/** Milliseconds `run` takes. */
export const elapsed = (run: () => unknown): number => {
	const start = performance.now();
	run();
	return performance.now() - start;
};

/** JSON as the tests write it: indented, so that lines and columns mean something. */
export const pretty = (value: unknown): string =>
	JSON.stringify(value, null, 2);

export const sha256 = (data: string | Buffer): string =>
	createHash("sha256").update(data).digest("hex");

/** The LOX documents this version is tested against. */
export const SPEC_DIR = resolve(import.meta.dir, "../spec");
