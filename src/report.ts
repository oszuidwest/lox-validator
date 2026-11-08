import packageJson from "../package.json";
import {
	type Diagnostic,
	NOT_CHECKED,
	type Severity,
	type SpecCheck,
	type ValidationResult,
} from "./types.ts";

export const REPORT_FORMAT_VERSION = 3;

/** The JSON report is an interface for agents. AGENTS.md documents it; change both together. */
interface ReportResult {
	file: string;
	ok: boolean;
	summary: ValidationResult["summary"];
	diagnostics: Diagnostic[];
	specCheck: SpecCheck | null;
}

export interface Report {
	formatVersion: typeof REPORT_FORMAT_VERSION;
	validatorVersion: string;
	ok: boolean;
	/** Next to `ok` on purpose: `ok` must not be read as "LOX will accept this". */
	notChecked: readonly string[];
	summary: { files: number; errors: number; warnings: number };
	results: ReportResult[];
}

export function buildReport(
	entries: readonly { file: string; result: ValidationResult }[],
): Report {
	const summary = { files: entries.length, errors: 0, warnings: 0 };
	const results = entries.map(({ file, result }): ReportResult => {
		summary.errors += result.summary.errors;
		summary.warnings += result.summary.warnings;
		return {
			file,
			ok: result.ok,
			summary: result.summary,
			diagnostics: result.diagnostics,
			specCheck: result.specCheck,
		};
	});
	return {
		formatVersion: REPORT_FORMAT_VERSION,
		validatorVersion: packageJson.version,
		ok: summary.errors === 0,
		notChecked: NOT_CHECKED,
		summary,
		results,
	};
}

// Control what a viewer shows of a report that quotes untrusted input: they reorder or split text,
// or start terminal sequences.
// Below U+007F JSON.stringify has escaped them already, and what is left is its own indentation.
const DISPLAY_CONTROLS = /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu;

/** JSON in which these occur only as escapes, so that it still parses back to the same text. */
export function toSafeJson(value: unknown, indent?: number): string {
	return JSON.stringify(value, null, indent).replace(DISPLAY_CONTROLS, (char) =>
		Array.from(
			{ length: char.length },
			(_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`,
		).join(""),
	);
}

export function formatJson(report: Report): string {
	return `${toSafeJson(report, 2)}\n`;
}

const SEVERITY_COLOR: Record<Severity, string> = {
	error: "\u001b[31m",
	warning: "\u001b[33m",
};
const COLOR_RESET = "\u001b[0m";

/**
 * File names and messages come from the input, which must not break the one-line format or drive
 * the terminal: no control characters, no line separators, and no bidi controls, which reorder
 * what the line appears to say.
 */
export function oneLine(text: string): string {
	return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatText(report: Report, color: boolean): string {
	const lines: string[] = [];
	for (const result of report.results) {
		for (const item of result.diagnostics) {
			const position =
				item.range === null ? "" : `:${item.range.line}:${item.range.column}`;
			const severity = color
				? `${SEVERITY_COLOR[item.severity]}${item.severity}${COLOR_RESET}`
				: item.severity;
			lines.push(
				`${oneLine(result.file)}${position}  ${severity}  ${item.ruleId}  ${oneLine(item.message)}`,
				`  fix: ${oneLine(item.fix)}`,
			);
		}
	}
	const { files, errors, warnings } = report.summary;
	lines.push(
		`${plural(errors, "error")}, ${plural(warnings, "warning")} in ${plural(files, "file")}`,
	);
	return `${lines.join("\n")}\n`;
}
