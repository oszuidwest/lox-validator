/** Shared contract between the modules of the validator. */

import type { RuleId } from "./rules.ts";

export type { RuleId };

export type Severity = "error" | "warning";

/** Lines and columns are 1-based; offsets are 0-based and index the original input. */
export interface SourceRange {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	offset: number;
	endOffset: number;
}

export interface Diagnostic {
	ruleId: RuleId;
	severity: Severity;
	message: string;
	/** What to change: for this occurrence when known, else the rule's fix. */
	fix: string;
	range: SourceRange | null;
	/** Up to 120 characters of the original input at `range`. */
	excerpt: string | null;
	/** JSON Pointer into the article, such as `/body/3/content/0`. */
	pointer: string | null;
}

export interface ValidateOptions {
	/** Directory with the LOX documents, for the optional extra check against them. */
	specDir?: string;
}

export interface SpecCheck {
	dir: string;
	schemaSha256: string;
	openapiSha256: string;
	/** False when the documents differ from the versions this validator was tested with. */
	matchesTested: boolean;
}

export interface ValidationResult {
	/** True when there are no errors. */
	ok: boolean;
	summary: { errors: number; warnings: number };
	diagnostics: Diagnostic[];
	/** Set only when the LOX documents were checked as well. */
	specCheck: SpecCheck | null;
	/** What `ok` says nothing about. Always `NOT_CHECKED`. */
	notChecked: readonly string[];
}

/** `ok` means the submission body meets the format and is consistent; it stops there. */
export const NOT_CHECKED: readonly string[] = [
	"Whether media URLs are reachable and public, including host names that resolve to internal addresses, their redirects, and the MIME type they serve",
	"Whether a declared byteSize or checksum matches the media",
	"Uploading media for upload delivery",
	"Whether links and embed targets exist",
	"Whether media refs are unique and stable across the broadcaster's articles",
	"Rights to distribute the content",
	"The tenant header and authentication",
	"Acceptance by the LOX server",
];

export interface Rule {
	id: RuleId;
	severity: Severity;
	/** One line: what this rule detects. */
	summary: string;
	/** Why the submission cannot go to LOX as is, or what it would lose. */
	why: string;
	/** What to change in the JSON. */
	fix: string;
	/** Where the rule comes from. */
	basis: string;
}
