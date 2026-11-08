/**
 * Synthetic LOX documents, built from the built-in rules, for tests that change them. They describe
 * the same format, so any difference a test sees comes from the change it makes to them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORMAT_SCHEMA } from "../src/lox-format.ts";
import { OPENAPI_FILE, SCHEMA_FILE } from "../src/spec-documents.ts";
import type { Json } from "./fixtures.ts";

/** FORMAT_SCHEMA without this validator's own annotations, which no LOX document has. */
function plainFormat(node: unknown = FORMAT_SCHEMA): unknown {
	if (Array.isArray(node)) return node.map(plainFormat);
	if (typeof node !== "object" || node === null) return node;
	return Object.fromEntries(
		Object.entries(node)
			.filter(([key]) => key !== "textField")
			.map(([key, value]) => [key, plainFormat(value)]),
	);
}

/** FORMAT_SCHEMA as a schema document. */
export const schemaDocument = (): Json => ({
	$schema: "https://json-schema.org/draft/2020-12/schema",
	...(plainFormat() as Json),
});

/** Replaces every `#/$defs/...` reference by a copy of its target. */
function inline(node: unknown, defs: Json): unknown {
	if (Array.isArray(node)) return node.map((item) => inline(item, defs));
	if (typeof node !== "object" || node === null) return node;
	const record = node as Json;
	if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/")) {
		return inline(defs[record.$ref.slice("#/$defs/".length)], defs);
	}
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, inline(value, defs)]),
	);
}

/** FORMAT_SCHEMA as the ArticleSubmission of an OpenAPI document, without references. */
export const openApiDocument = (): Json => {
	const { $defs, ...root } = plainFormat() as Json;
	return {
		openapi: "3.1.0",
		components: { schemas: { ArticleSubmission: inline(root, $defs) } },
	};
};

/** Temporary directories with documents; call `cleanup` in afterAll. */
export function documentDirectories() {
	const dirs: string[] = [];
	return {
		write(schema: unknown, openapi: unknown, raw = false): string {
			const dir = mkdtempSync(join(tmpdir(), "lox-documents-"));
			dirs.push(dir);
			const text = (document: unknown) =>
				raw ? String(document) : JSON.stringify(document, null, 2);
			writeFileSync(join(dir, SCHEMA_FILE), text(schema));
			writeFileSync(join(dir, OPENAPI_FILE), text(openapi));
			return dir;
		},
		cleanup(): void {
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		},
	};
}
