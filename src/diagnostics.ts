import { getRule } from "./rules.ts";
import type { Diagnostic, RuleId, SourceRange } from "./types.ts";

const EXCERPT_LENGTH = 120;

/**
 * Ranges for offsets into `input`. The line index is built on first use and lives as long as the
 * returned function: one validation, not the module.
 */
export function rangesIn(
	input: string,
): (start: number, end: number) => SourceRange {
	let lineStarts: number[] | undefined;
	const position = (offset: number) => {
		if (lineStarts === undefined) {
			lineStarts = [0];
			// A line ends at \n, \r\n or a lone \r, as JSON whitespace allows all three.
			for (const match of input.matchAll(/\r\n?|\n/g)) {
				lineStarts.push(match.index + match[0].length);
			}
		}
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if ((lineStarts[middle] as number) <= offset) low = middle;
			else high = middle - 1;
		}
		return { line: low + 1, column: offset - (lineStarts[low] as number) + 1 };
	};
	return (start, end) => {
		const from = position(start);
		const to = position(end);
		return {
			line: from.line,
			column: from.column,
			endLine: to.line,
			endColumn: to.column,
			offset: start,
			endOffset: end,
		};
	};
}

interface DiagnosticDetails {
	/** Name the concrete element or value. */
	message: string;
	/** A concrete instruction for this occurrence; defaults to the rule's fix. */
	fix?: string | undefined;
	range?: SourceRange | null;
	pointer?: string | null;
}

/** Severity and the default fix come from the rule catalog, so a rule reads the same everywhere. */
export function diagnostic(
	ruleId: RuleId,
	input: string,
	details: DiagnosticDetails,
): Diagnostic {
	const rule = getRule(ruleId);
	const range = details.range ?? null;
	return {
		ruleId,
		severity: rule.severity,
		message: details.message,
		fix: details.fix ?? rule.fix,
		range,
		excerpt:
			range === null
				? null
				: input.slice(
						range.offset,
						Math.min(range.endOffset, range.offset + EXCERPT_LENGTH),
					),
		pointer: details.pointer ?? null,
	};
}
