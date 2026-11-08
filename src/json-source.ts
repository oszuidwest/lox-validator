/**
 * A strict RFC 8259 parser that keeps where each value and key sits in the text.
 *
 * `JSON.parse` silently keeps the last of two equal keys and cannot say where a value came from, so
 * a report could neither flag the duplicate nor point at the line to fix.
 */

/** Offsets are 0-based UTF-16 indexes into the text; `end` is exclusive. */
export interface Span {
	start: number;
	end: number;
}

export interface Located {
	/** The whole value. */
	value: Span;
	/** The property name, for values inside an object. */
	key?: Span;
}

export interface Duplicate {
	pointer: string;
	key: Span;
	first: Span;
}

export interface ParseSuccess {
	ok: true;
	value: unknown;
	/** Every value by its JSON Pointer; the root is `""`. */
	locations: Map<string, Located>;
	duplicates: Duplicate[];
	/** Strings that hold a lone surrogate, which is no text. */
	brokenStrings: { pointer: string; span: Span }[];
}

export interface ParseFailure {
	ok: false;
	message: string;
	offset: number;
}

type ParseResult = ParseSuccess | ParseFailure;

/** Real articles nest about ten levels; this keeps a hostile input from exhausting the stack. */
export const MAX_DEPTH = 256;

class SyntaxFailure extends Error {
	constructor(
		message: string,
		readonly offset: number,
	) {
		super(message);
	}
}

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function escapePointerSegment(segment: string): string {
	return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointerSegment(segment: string): string {
	return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** The unescaped segments of a JSON Pointer; the root `""` has none. */
export function pointerPath(pointer: string): string[] {
	return pointer === ""
		? []
		: pointer.split("/").slice(1).map(unescapePointerSegment);
}

/** Whether `pointer` is one of `elements` or lies inside one: a lookup per level. */
export function withinAny(
	pointer: string,
	elements: ReadonlySet<string>,
): boolean {
	for (let at = pointer; ; at = at.slice(0, at.lastIndexOf("/"))) {
		if (elements.has(at)) return true;
		if (at === "") return false;
	}
}

const ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** A run of string characters that need no attention: no quote, backslash or control character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 to U+001F are what JSON strings forbid unescaped.
const PLAIN = /[^"\\\u0000-\u001f]+/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;

function describe(char: string | undefined): string {
	if (char === undefined) return "the end of the input";
	const code = char.codePointAt(0) ?? 0;
	// Shown by code point: invisible or easily mistaken in a message.
	const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
	if (/\p{Cc}/u.test(char)) return `control character ${hex}`;
	if (code !== 0x20 && /[\p{Cf}\p{Z}]/u.test(char)) return hex;
	return JSON.stringify(char);
}

export function parseJson(text: string): ParseResult {
	let at = 0;
	const locations = new Map<string, Located>();
	const duplicates: Duplicate[] = [];
	const brokenStrings: { pointer: string; span: Span }[] = [];

	const fail = (message: string, offset = at): never => {
		throw new SyntaxFailure(message, offset);
	};

	const skipWhitespace = () => {
		while (at < text.length) {
			const char = text[at];
			if (char === " " || char === "\t" || char === "\n" || char === "\r") at++;
			else break;
		}
	};

	const expect = (char: string, context: string) => {
		if (text[at] !== char)
			fail(
				`expected ${JSON.stringify(char)} ${context}, found ${describe(text[at])}`,
			);
		at++;
	};

	const parseString = (): string => {
		const start = at;
		at++; // opening quote
		let out = "";
		let chunk = at;
		while (true) {
			PLAIN.lastIndex = at;
			if (PLAIN.test(text)) at = PLAIN.lastIndex;
			if (at >= text.length) fail("unterminated string", start);
			const char = text[at] as string;
			if (char === '"') {
				out += text.slice(chunk, at);
				at++;
				return out;
			}
			if (char !== "\\") {
				fail(
					`${describe(char)} inside a string; write it as an escape such as \\n`,
				);
			}
			out += text.slice(chunk, at);
			const kind = text[at + 1];
			if (kind === "u") {
				const hex = text.slice(at + 2, at + 6);
				if (!HEX4.test(hex))
					fail("\\u must be followed by four hexadecimal digits");
				out += String.fromCharCode(Number.parseInt(hex, 16));
				at += 6;
			} else if (kind !== undefined && kind in ESCAPES) {
				out += ESCAPES[kind];
				at += 2;
			} else {
				fail(`invalid escape \\${kind ?? ""}`);
			}
			chunk = at;
		}
	};

	const parseValue = (pointer: string, depth: number, key?: Span): unknown => {
		skipWhitespace();
		const start = at;
		const char = text[at];
		let value: unknown;
		if (depth > MAX_DEPTH) fail(`nested deeper than ${MAX_DEPTH} levels`);
		if (char === "{") value = parseObject(pointer, depth);
		else if (char === "[") value = parseArray(pointer, depth);
		else if (char === '"') {
			const string = parseString();
			if (!string.isWellFormed())
				brokenStrings.push({ pointer, span: { start, end: at } });
			value = string;
		} else if (
			char === "-" ||
			(char !== undefined && char >= "0" && char <= "9")
		) {
			NUMBER.lastIndex = at;
			const [number] = NUMBER.exec(text) ?? fail("invalid number");
			at += number.length;
			value = Number(number);
		} else if (text.startsWith("true", at)) {
			at += 4;
			value = true;
		} else if (text.startsWith("false", at)) {
			at += 5;
			value = false;
		} else if (text.startsWith("null", at)) {
			at += 4;
			value = null;
		} else {
			fail(`expected a value, found ${describe(char)}`);
		}
		locations.set(
			pointer,
			key === undefined
				? { value: { start, end: at } }
				: { value: { start, end: at }, key },
		);
		return value;
	};

	const parseObject = (pointer: string, depth: number) => {
		const object: Record<string, unknown> = {};
		const keys = new Map<string, Span>();
		at++;
		skipWhitespace();
		if (text[at] === "}") {
			at++;
			return object;
		}
		while (true) {
			skipWhitespace();
			if (text[at] !== '"')
				fail(
					`expected a property name in double quotes, found ${describe(text[at])}`,
				);
			const keyStart = at;
			const name = parseString();
			const keySpan = { start: keyStart, end: at };
			const child = `${pointer}/${escapePointerSegment(name)}`;
			if (!name.isWellFormed())
				brokenStrings.push({ pointer: child, span: keySpan });
			const first = keys.get(name);
			if (first !== undefined)
				duplicates.push({ pointer: child, key: keySpan, first });
			else keys.set(name, keySpan);
			skipWhitespace();
			expect(":", "after a property name");
			const value = parseValue(child, depth + 1, keySpan);
			// Like JSON.parse: the last one wins, and `__proto__` stays an ordinary property.
			Object.defineProperty(object, name, {
				value,
				enumerable: true,
				writable: true,
				configurable: true,
			});
			skipWhitespace();
			if (text[at] === ",") {
				at++;
				skipWhitespace();
				if (text[at] === "}") fail("trailing comma before }");
				continue;
			}
			expect("}", "or , after a property value");
			return object;
		}
	};

	const parseArray = (pointer: string, depth: number) => {
		const array: unknown[] = [];
		at++;
		skipWhitespace();
		if (text[at] === "]") {
			at++;
			return array;
		}
		while (true) {
			array.push(parseValue(`${pointer}/${array.length}`, depth + 1));
			skipWhitespace();
			if (text[at] === ",") {
				at++;
				skipWhitespace();
				if (text[at] === "]") fail("trailing comma before ]");
				continue;
			}
			expect("]", "or , after an array item");
			return array;
		}
	};

	try {
		if (text.charCodeAt(0) === 0xfeff)
			fail("the input starts with a byte order mark; remove it", 0);
		const value = parseValue("", 0);
		skipWhitespace();
		if (at < text.length)
			fail(`unexpected ${describe(text[at])} after the JSON value`);
		return { ok: true, value, locations, duplicates, brokenStrings };
	} catch (error) {
		if (error instanceof SyntaxFailure) {
			return { ok: false, message: error.message, offset: error.offset };
		}
		throw error;
	}
}
