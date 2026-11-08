import {
	checkBlankBlocks,
	checkMedia,
	checkSubmissionFields,
	checkText,
	type Finding,
	unknownPropertyFinding,
} from "./checks.ts";
import { diagnostic, rangesIn } from "./diagnostics.ts";
import {
	isObject,
	type Located,
	parseJson,
	pointerPath,
	type Span,
} from "./json-source.ts";
import { checkFormat, type FormatIssue, Reported, show } from "./lox-format.ts";
import { checkAgainstDocuments, loadDocuments } from "./spec-documents.ts";
import {
	type Diagnostic,
	NOT_CHECKED,
	type SourceRange,
	type SpecCheck,
	type ValidateOptions,
	type ValidationResult,
} from "./types.ts";

/** Far above the format's own limits, which allow at most a few hundred kilobytes of text per run. */
export const MAX_INPUT_LENGTH = 16 * 1024 * 1024;

function result(
	diagnostics: Diagnostic[],
	specCheck: SpecCheck | null,
): ValidationResult {
	const count = (severity: Diagnostic["severity"]) =>
		diagnostics.filter((item) => item.severity === severity).length;
	const summary = {
		errors: count("error"),
		warnings: count("warning"),
	};
	return {
		ok: summary.errors === 0,
		summary,
		diagnostics,
		specCheck,
		notChecked: NOT_CHECKED,
	};
}

function compareText(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null || b === null) return a === null ? 1 : -1;
	return a < b ? -1 : 1;
}

/** Plain comparisons, not localeCompare: the same input gives the same order everywhere. */
function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
	if (a.range !== null && b.range !== null) {
		const byPosition =
			a.range.offset - b.range.offset || a.range.endOffset - b.range.endOffset;
		if (byPosition !== 0) return byPosition;
	} else if (a.range !== b.range) {
		return a.range === null ? 1 : -1;
	}
	return (
		compareText(a.ruleId, b.ruleId) ||
		compareText(a.pointer, b.pointer) ||
		compareText(a.message, b.message)
	);
}

/**
 * The nearest located value at or above `pointer`: a missing property points at its object. The
 * root is always located, so the walk ends there at the latest.
 */
function locate(
	pointer: string,
	locations: ReadonlyMap<string, Located>,
	atKey: boolean,
): Span {
	for (let path = pointer; ; path = path.slice(0, path.lastIndexOf("/"))) {
		const found = locations.get(path);
		if (found !== undefined) {
			return path === pointer && atKey && found.key ? found.key : found.value;
		}
		if (path === "") throw new Error(`No location for ${pointer}`);
	}
}

/**
 * Checks one article submission, given as JSON text, against the LOX format.
 *
 * Throws only for a problem outside the input: unreadable or broken LOX documents in `specDir`.
 */
export function validate(
	input: string,
	options: ValidateOptions = {},
): ValidationResult {
	// First, so that broken documents give their error whatever the input holds.
	const documents =
		options.specDir === undefined ? null : loadDocuments(options.specDir);

	if (input.length > MAX_INPUT_LENGTH) {
		return result(
			[
				diagnostic("input/too-large", input, {
					message: `The input has ${input.length} characters; this validator reads at most ${MAX_INPUT_LENGTH}`,
				}),
			],
			null,
		);
	}

	const rangeAt = rangesIn(input);
	const parsed = parseJson(input);
	if (!parsed.ok) {
		const offset = Math.min(parsed.offset, input.length);
		return result(
			[
				diagnostic("json/syntax", input, {
					message: `Invalid JSON: ${parsed.message}`,
					range: rangeAt(offset, Math.min(offset + 1, input.length)),
				}),
			],
			null,
		);
	}

	const { value: article, locations } = parsed;
	const range = (span: Span): SourceRange => rangeAt(span.start, span.end);
	const fromFinding = (finding: Finding): Diagnostic =>
		diagnostic(finding.ruleId, input, {
			message: finding.message,
			fix: finding.fix,
			pointer: finding.pointer,
			range: range(locate(finding.pointer, locations, finding.atKey === true)),
		});
	const fromIssue =
		(ruleId: "format/violation" | "spec/violation") => (issue: FormatIssue) =>
			fromFinding({ ruleId, pointer: issue.pointer, message: issue.message });

	const diagnostics: Diagnostic[] = [];
	for (const duplicate of parsed.duplicates) {
		const name = pointerPath(duplicate.pointer).at(-1) ?? "";
		const first = range(duplicate.first);
		diagnostics.push(
			diagnostic("json/duplicate-key", input, {
				message: `${show(name)} appears again; the first is at line ${first.line}, column ${first.column}`,
				pointer: duplicate.pointer,
				range: range(duplicate.key),
			}),
		);
	}
	for (const broken of parsed.brokenStrings) {
		diagnostics.push(
			diagnostic("json/invalid-string", input, {
				message: "The string holds a lone surrogate, which is no character",
				pointer: broken.pointer,
				range: range(broken.span),
			}),
		);
	}

	const { issues, unknown, text } = checkFormat(article);
	diagnostics.push(...issues.map(fromIssue("format/violation")));

	if (isObject(article)) {
		const findings: Finding[] = [
			...checkSubmissionFields(article),
			...checkMedia(article),
			...checkText(text),
			...checkBlankBlocks(article),
			...unknown.map(unknownPropertyFinding),
		];
		diagnostics.push(...findings.map(fromFinding));
	}

	if (documents !== null) {
		const { specCheck } = documents;
		if (!specCheck.matchesTested) {
			diagnostics.push(
				diagnostic("spec/changed", input, {
					message: `The LOX documents in ${specCheck.dir} differ from the versions this validator was tested with`,
				}),
			);
		}
		const reported = new Reported();
		reported.add(issues);
		diagnostics.push(
			...checkAgainstDocuments(article, documents, reported).map(
				fromIssue("spec/violation"),
			),
		);
	}

	return result(
		diagnostics.sort(compareDiagnostics),
		documents?.specCheck ?? null,
	);
}
