import { describe, expect, test } from "bun:test";
import {
	escapePointerSegment,
	MAX_DEPTH,
	type ParseFailure,
	type ParseSuccess,
	parseJson,
} from "../src/json-source.ts";
import { EXAMPLE_TEXT } from "./fixtures.ts";

const success = (text: string): ParseSuccess => {
	const result = parseJson(text);
	if (!result.ok)
		throw new Error(`expected ${text} to parse: ${result.message}`);
	return result;
};
const failure = (text: string): ParseFailure => {
	const result = parseJson(text);
	if (result.ok) throw new Error(`expected ${text} to fail`);
	return result;
};
const slice = (text: string, span: { start: number; end: number }) =>
	text.slice(span.start, span.end);

describe("syntax errors", () => {
	const cases: [string, string, RegExp, number][] = [
		["trailing comma in an array", "[1,]", /trailing comma before \]/, 3],
		["trailing comma in an object", '{"a":1,}', /trailing comma before \}/, 7],
		[
			"trailing comma with whitespace",
			'{"a":1 ,\n }',
			/trailing comma before \}/,
			10,
		],
		["line comment", "// x\n1", /expected a value, found "\/"/, 0],
		["block comment", "/* x */ 1", /expected a value, found "\/"/, 0],
		["comment after a value", "[1 /* x */]", /expected "\]" or ,/, 3],
		["single-quoted string", "'a'", /expected a value, found "'"/, 0],
		[
			"single-quoted property name",
			"{'a':1}",
			/expected a property name in double quotes, found "'"/,
			1,
		],
		["unquoted property name", "{a:1}", /property name in double quotes/, 1],
		["byte order mark", "\ufeff{}", /byte order mark/, 0],
		[
			"control character in a string",
			'"a\u0001b"',
			/control character U\+0001 inside a string/,
			2,
		],
		["raw tab in a string", '"a\tb"', /control character U\+0009/, 2],
		["raw newline in a string", '"a\nb"', /control character U\+000A/, 2],
		["unknown escape", '"\\x"', /invalid escape \\x/, 1],
		["escaped single quote", '"\\\'"', /invalid escape \\'/, 1],
		["backslash at the end", '"\\', /invalid escape \\$/, 1],
		["short \\u escape", '"\\u12"', /\\u must be followed by four/, 1],
		["non-hex \\u escape", '"\\u12G4"', /\\u must be followed by four/, 1],
		["\\u without digits", '"\\u"', /\\u must be followed by four/, 1],
		["leading zero", "01", /unexpected "1" after the JSON value/, 1],
		["negative leading zero", "-01", /unexpected "1" after the JSON value/, 2],
		["leading zero in an array", "[00]", /expected "\]" or ,/, 2],
		["NaN", "NaN", /expected a value, found "N"/, 0],
		["Infinity", "Infinity", /expected a value, found "I"/, 0],
		["-Infinity", "-Infinity", /invalid number/, 0],
		["lone minus", "-", /invalid number/, 0],
		["plus sign", "+1", /expected a value, found "\+"/, 0],
		["leading dot", ".5", /expected a value, found "\."/, 0],
		["trailing dot", "1.", /unexpected "\." after the JSON value/, 1],
		["bare exponent", "1e", /unexpected "e" after the JSON value/, 1],
		["hex number", "0x10", /unexpected "x" after the JSON value/, 1],
		["trailing garbage", "{} x", /unexpected "x" after the JSON value/, 3],
		["second value", "1 2", /unexpected "2" after the JSON value/, 2],
		["truncated literal", "tru", /expected a value, found "t"/, 0],
		["capitalised literal", "True", /expected a value, found "T"/, 0],
		["unterminated string", '"abc', /unterminated string/, 0],
		["unterminated nested string", '{"a": "b', /unterminated string/, 6],
		["unterminated array", "[1", /found the end of the input/, 2],
		["unterminated object", '{"a":1', /found the end of the input/, 6],
		["missing colon", '{"a" 1}', /expected ":" after a property name/, 5],
		["missing comma", "[1 2]", /expected "\]" or , after an array item/, 3],
		["empty input", "", /expected a value, found the end of the input/, 0],
		["whitespace only", " \n\t", /found the end of the input/, 3],
		["no-break space is not whitespace", "\u00a01", /expected a value/, 0],
		["vertical tab is not whitespace", "\v1", /control character U\+000B/, 0],
		["form feed is not whitespace", "\f1", /control character U\+000C/, 0],
		["leading comma", "[,1]", /expected a value, found ","/, 1],
		["missing value", '{"a":}', /expected a value, found "}"/, 5],
	];

	for (const [name, input, message, offset] of cases) {
		test(name, () => {
			const result = failure(input);
			expect(result.message).toMatch(message);
			expect(result.offset).toBe(offset);
			// The built-in parser agrees that this is not JSON.
			expect(() => JSON.parse(input)).toThrow();
		});
	}

	test("a byte order mark after leading whitespace is not whitespace", () => {
		expect(failure(" \ufeff{}").message).toMatch(/expected a value/);
	});

	test("DEL and other non-control characters are allowed in strings", () => {
		expect(success('"a\u007fb\u0080c\u2028"').value).toBe(
			"a\u007fb\u0080c\u2028",
		);
	});
});

describe("values", () => {
	test("every escape decodes", () => {
		expect(success('"\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\u00E9"').value).toBe(
			'"\\/\b\f\n\r\té\u00e9',
		);
	});

	test("numbers decode like JSON.parse", () => {
		for (const number of [
			"0",
			"-0",
			"12",
			"-12",
			"1.5",
			"1e3",
			"1E+3",
			"1.5e-3",
			"9007199254740993",
			"1e400",
		]) {
			expect(success(number).value).toBe(JSON.parse(number));
		}
	});

	test("the example article decodes exactly like JSON.parse", () => {
		expect(success(EXAMPLE_TEXT).value).toEqual(JSON.parse(EXAMPLE_TEXT));
	});

	test("empty containers and literals", () => {
		expect(success("{}").value).toEqual({});
		expect(success("[]").value).toEqual([]);
		expect(success(" true ").value).toBe(true);
		expect(success("false").value).toBe(false);
		expect(success("null").value).toBeNull();
		expect(success('""').value).toBe("");
	});

	test("agrees with JSON.parse on random mutations of a document", () => {
		// A small deterministic generator: same mutations on every run.
		let seed = 12345;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const base =
			'{"a": [1, -2.5e3, "x\\n\\u00e9", true, null], "b": {"c": ""}}';
		const alphabet = "{}[]\":,-+.0123456789eE \\/ntrufalsx\u0001'";
		let disagreements = 0;
		for (let round = 0; round < 3000; round++) {
			const chars = [...base];
			const edits = 1 + Math.floor(random() * 3);
			for (let edit = 0; edit < edits; edit++) {
				const at = Math.floor(random() * chars.length);
				const char = alphabet[Math.floor(random() * alphabet.length)] ?? "";
				const choice = random();
				if (choice < 0.33) chars.splice(at, 1);
				else if (choice < 0.66) chars.splice(at, 0, char);
				else chars[at] = char;
			}
			const input = chars.join("");
			let expected: unknown;
			let valid = true;
			try {
				expected = JSON.parse(input);
			} catch {
				valid = false;
			}
			const result = parseJson(input);
			if (result.ok !== valid) disagreements++;
			else if (result.ok) {
				// Duplicate keys: both keep the last value.
				expect(result.value).toEqual(expected);
			}
		}
		expect(disagreements).toBe(0);
	});
});

describe("positions", () => {
	const input =
		'{\n  "title": "Kop",\n  "body": [\n    {"type": "x"},\n    42\n  ]\n}';

	test("every value is located by its pointer, the root as the empty pointer", () => {
		const { locations } = success(input);
		expect([...locations.keys()].sort()).toEqual([
			"",
			"/body",
			"/body/0",
			"/body/0/type",
			"/body/1",
			"/title",
		]);
		const at = (pointer: string) => {
			const located = locations.get(pointer);
			if (located === undefined) throw new Error(pointer);
			return located;
		};
		expect(slice(input, at("").value)).toBe(input);
		expect(slice(input, at("/title").value)).toBe('"Kop"');
		expect(slice(input, at("/body/0").value)).toBe('{"type": "x"}');
		expect(slice(input, at("/body/0/type").value)).toBe('"x"');
		expect(slice(input, at("/body/1").value)).toBe("42");
	});

	test("values inside objects carry the span of their key; array items and the root do not", () => {
		const { locations } = success(input);
		const title = locations.get("/title");
		expect(title?.key && slice(input, title.key)).toBe('"title"');
		const type = locations.get("/body/0/type");
		expect(type?.key && slice(input, type.key)).toBe('"type"');
		expect(locations.get("/body/1")?.key).toBeUndefined();
		expect(locations.get("")?.key).toBeUndefined();
	});

	test("a span covers the whole value, nested containers included", () => {
		const { locations } = success(input);
		const body = locations.get("/body");
		expect(body && slice(input, body.value)).toBe(
			'[\n    {"type": "x"},\n    42\n  ]',
		);
	});

	test("an error deep in the text gives the offset of the offending character", () => {
		const text = '{\n  "a": [1, 2,\n  ]\n}';
		const result = failure(text);
		expect(result.offset).toBe(text.indexOf("]"));
	});

	test("an unterminated string points at its opening quote", () => {
		const text = '{"a": 1, "b": "never closed}';
		expect(failure(text).offset).toBe(text.indexOf('"never'));
	});

	test("offsets count UTF-16 code units", () => {
		const text = '{"😀": "é", "b": 1}';
		const { locations } = success(text);
		const b = locations.get("/b");
		expect(b?.value).toEqual({
			start: text.indexOf("1"),
			end: text.indexOf("1") + 1,
		});
	});
});

describe("duplicate keys", () => {
	test("the last value wins and the first position is recorded", () => {
		const text = '{"a": 1, "a": 2}';
		const result = success(text);
		expect(result.value).toEqual({ a: 2 });
		expect(result.duplicates).toEqual([
			{
				pointer: "/a",
				key: { start: 9, end: 12 },
				first: { start: 1, end: 4 },
			},
		]);
		// The location is the one of the value that is kept.
		expect(result.locations.get("/a")?.value).toEqual({ start: 14, end: 15 });
	});

	test("duplicates in nested objects carry the nested pointer", () => {
		const text =
			'{"m": [{"x": 1, "y": 2, "x": 3}], "n": {"z": {"q": 1, "q": 1}}}';
		const result = success(text);
		expect(result.duplicates.map((duplicate) => duplicate.pointer)).toEqual([
			"/m/0/x",
			"/n/z/q",
		]);
		for (const duplicate of result.duplicates) {
			expect(slice(text, duplicate.key)).toBe(slice(text, duplicate.first));
			expect(duplicate.key.start).toBeGreaterThan(duplicate.first.start);
		}
	});

	test("equal names in different objects are no duplicates", () => {
		expect(success('{"a": {"x": 1}, "b": {"x": 1}}').duplicates).toEqual([]);
		expect(success('[{"x": 1}, {"x": 1}]').duplicates).toEqual([]);
	});

	test("names that only look alike are different", () => {
		expect(success('{"a": 1, "A": 1, "a ": 1}').duplicates).toEqual([]);
	});

	test("an escaped spelling of the same name is a duplicate", () => {
		const result = success('{"a": 1, "\\u0061": 2}');
		expect(result.duplicates).toHaveLength(1);
		expect(result.value).toEqual({ a: 2 });
	});

	test("every repetition is recorded", () => {
		const text = '{"a": 1, "a": 2, "a": 3}';
		const result = success(text);
		expect(result.duplicates).toHaveLength(2);
		expect(result.value).toEqual({ a: 3 });
		for (const duplicate of result.duplicates) {
			expect(duplicate.first.start).toBeLessThan(duplicate.key.start);
		}
	});
});

describe("__proto__", () => {
	test("is an ordinary own property, like in JSON.parse", () => {
		const text = '{"__proto__": {"polluted": true}, "constructor": 1}';
		const value = success(text).value as Record<string, unknown>;
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.keys(value)).toEqual(["__proto__", "constructor"]);
		expect(Object.hasOwn(value, "__proto__")).toBe(true);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(value).toEqual(JSON.parse(text));
	});

	test("a duplicated __proto__ is reported like any other key", () => {
		const result = success('{"__proto__": 1, "__proto__": 2}');
		expect(result.duplicates.map((duplicate) => duplicate.pointer)).toEqual([
			"/__proto__",
		]);
		expect(
			Object.getOwnPropertyDescriptor(result.value, "__proto__")?.value,
		).toBe(2);
	});

	test("is located by its pointer", () => {
		expect(success('{"__proto__": 1}').locations.has("/__proto__")).toBe(true);
	});
});

describe("surrogates", () => {
	const broken = (text: string) => success(text).brokenStrings;

	test("a valid escaped pair is one character and not broken", () => {
		const result = success('"\\ud83d\\ude00"');
		expect(result.value).toBe("😀");
		expect(result.brokenStrings).toEqual([]);
	});

	test("a literal astral character is not broken", () => {
		expect(broken('"😀"')).toEqual([]);
	});

	for (const [name, text] of [
		["a lone high surrogate", '"\\ud800"'],
		["a lone low surrogate", '"\\udc00"'],
		["a reversed pair", '"\\ude00\\ud83d"'],
		["a high surrogate before a normal character", '"\\ud83dx"'],
		["a high surrogate at the end after text", '"abc\\ud83d"'],
	] as const) {
		test(`${name} is reported with its pointer and span`, () => {
			const input = `{"a": [${text}]}`;
			expect(broken(input)).toEqual([
				{
					pointer: "/a/0",
					span: { start: 7, end: 7 + text.length },
				},
			]);
		});
	}

	test("a lone surrogate in a raw JavaScript string is reported too", () => {
		expect(broken('"\ud800"')).toHaveLength(1);
	});

	test("a lone surrogate in a property name is reported", () => {
		expect(broken('{"\\ud800": 1}')).toHaveLength(1);
	});

	test("each broken string is reported once", () => {
		expect(broken('["\\ud800", "ok", "\\udfff\\udfff"]')).toHaveLength(2);
	});
});

describe("depth", () => {
	const arrays = (depth: number) => "[".repeat(depth) + "]".repeat(depth);

	test(`${MAX_DEPTH + 1} nested containers parse (the root is depth 0)`, () => {
		expect(parseJson(arrays(MAX_DEPTH + 1)).ok).toBe(true);
	});

	test("one more level is a diagnostic at the opening bracket", () => {
		const result = failure(arrays(MAX_DEPTH + 2));
		expect(result.message).toBe(`nested deeper than ${MAX_DEPTH} levels`);
		expect(result.offset).toBe(MAX_DEPTH + 1);
	});

	test("deep objects are limited too", () => {
		const depth = MAX_DEPTH + 2;
		const text = `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
		expect(failure(text).message).toMatch(/nested deeper/);
	});

	test("a million open brackets give a diagnostic, not a stack overflow", () => {
		expect(failure("[".repeat(1_000_000)).message).toMatch(/nested deeper/);
		expect(failure('{"a":'.repeat(500_000)).message).toMatch(/nested deeper/);
	});

	test("depth counts nesting, not the number of containers", () => {
		const wide = `[${Array.from({ length: 10_000 }, () => "[[]]").join(",")}]`;
		expect(parseJson(wide).ok).toBe(true);
	});
});

describe("pointers", () => {
	test("~ and / in names are escaped as ~0 and ~1", () => {
		const { locations, duplicates } = success(
			'{"a/b": {"~c": 1, "~1": 2, "x~/y": 3, "": 4, "~c": 5}}',
		);
		expect([...locations.keys()].sort()).toEqual(
			["", "/a~1b", "/a~1b/~0c", "/a~1b/~01", "/a~1b/x~0~1y", "/a~1b/"].sort(),
		);
		expect(duplicates[0]?.pointer).toBe("/a~1b/~0c");
	});

	test("escapePointerSegment escapes ~ before /", () => {
		expect(escapePointerSegment("~/")).toBe("~0~1");
		expect(escapePointerSegment("/~")).toBe("~1~0");
		expect(escapePointerSegment("~1")).toBe("~01");
		expect(escapePointerSegment("plain")).toBe("plain");
	});
});
