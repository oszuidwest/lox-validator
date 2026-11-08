# lox-validator for agents

Checks a LOX article submission before it goes to LOX. The input is the JSON body of `POST /api/v1/article`, an `ArticleSubmission`: `externalId`, `metadata`, `title`, optional `summary` and `hero`, `body` (ordered blocks) and `media` (one declaration per media file the hero and body use). [`examples/article.json`](examples/article.json) is a valid one.

LOX takes no HTML. Body content is blocks: `paragraph`, `heading` (level 2-6), `image`, `video`, `audio`, `list`, `quote` and `embed`. Rich text is an array of `text` runs with optional `marks`, `link`s whose children are text runs, and `lineBreak`s.

## The fix loop

Run this from any repo:

```sh
bunx github:oszuidwest/lox-validator#v0.0.1 --format json article.json
# or from stdin:
echo "$json" | bunx github:oszuidwest/lox-validator#v0.0.1 --format json -
# or from a local checkout, after `bun install`:
bun /path/to/lox-validator/src/cli.ts --format json article.json
```

Always use a version tag. Without one, `bunx` keeps running the copy it cached first, even `#main`, and says nothing about it. `validatorVersion` in the report shows what ran.

1. Read `results[].diagnostics`. `pointer` is a JSON Pointer into your submission; `range` and `excerpt` show where it is in the text.
2. Change the JSON as each `fix` says. Errors must be fixed. Warnings are optional, but most point at content that would be lost or shown wrong, such as a misspelled field or `&amp;` in text: fix those unless you mean it.
3. Run again until `ok` is `true`. A JSON syntax error stops all other checks, so more diagnostics can appear after you fix one.
4. Report the warnings that remain, and any content you changed or gave up, to the person.

Pass a file, or `-` for stdin. Without either, the validator stops with exit 2.

## Writing a submission

- Plain-text fields (title, summary, captions, headings, credits) take text, not HTML. Decode entities: `&amp;` becomes `&`, `&nbsp;` a no-break space.
- Bold, italic and the other marks go in `marks` on a text run. A line break inside a paragraph is `{"type":"lineBreak"}`, not `\n`.
- Every `ref` used by `hero` or an `image`, `video` or `audio` block needs exactly one declaration in `media` with the same `ref`, a matching `kind`, a `mimeType` and a `delivery`. The ref is the filename, case-sensitive.
- `delivery` is `{"method":"url","url":"https://..."}` with a public URL when LOX should fetch the file, or `{"method":"upload"}` with `byteSize` and `checksum` on the declaration when you upload it yourself.
- Timestamps are RFC 3339 with an offset, such as `2026-11-07T09:30:00+01:00`.
- Do not send `formatVersion`, `contentType`, `loxId`, `extensions` or `sourceIds`: they belong to the article as LOX stores it, not to a submission.

## What `ok` means

`ok: true` means the submission meets the format and is consistent. Nothing more. It does not mean LOX will accept the article. `notChecked` in the report lists what this tool cannot verify:

- whether media URLs are reachable and public, including host names that resolve to internal addresses, their redirects, and the MIME type they serve
- whether a declared `byteSize` or `checksum` matches the media
- uploading media for upload delivery
- whether links and embed targets exist
- whether media refs are unique and stable across the broadcaster's articles
- rights to distribute the content
- the tenant header and authentication
- acceptance by the LOX server

## Options

| Option                | Meaning                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `--format text\|json` | Output format. Default `text`.                                                |
| `--spec-dir <dir>`    | Also check against the LOX documents. Falls back to `LOX_SPEC_DIR`. Optional. |

### Checking against the LOX documents

The validator works without the documents, through its built-in rules, which are the strictest reading of the submission API and the article schema together. The tested versions are in `spec/`. `--spec-dir` adds a check against the documents in a directory, such as a newer version. An empty `--spec-dir ""` is a usage error, and an empty `LOX_SPEC_DIR` counts as unset.

- `spec/violation` is what only the documents reject.
- `spec/changed` means the documents differ from the tested versions, so the built-in rules may be out of date. It does not mean the new version is supported.
- The OpenAPI document, as published, rejects every paragraph, quote, media block, text run, link and url delivery, because its `oneOf` alternatives overlap. The validator ties each alternative to its `type`, `method` or `algorithm` before checking. That is a reading of what the document means, not proof of what the server does.
- Documents the validator cannot enforce in full give exit 2.

## Exit codes

| Code | Meaning                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------- |
| 0    | No errors. Warnings do not change the exit code.                                                   |
| 1    | Errors in a submission.                                                                            |
| 2    | Usage error, unreadable file, directory, invalid UTF-8, bad LOX documents, or an internal failure. |

On exit 2 with `--format json`, stdout holds `{"formatVersion":3,"fatal":"message"}` and stderr the message. Once the report has started, a failure leaves the report, whole or cut short, alone on stdout. Exit 2 says nothing about the submission, even then.

## JSON report

```jsonc
{
	"formatVersion": 3,
	"validatorVersion": "0.0.1",
	"ok": false, // true when no file has errors
	"notChecked": ["..."], // always the same list; see "What ok means"
	"summary": { "files": 1, "errors": 1, "warnings": 0 },
	"results": [
		{
			"file": "article.json", // "<stdin>" for stdin
			"ok": false, // no errors in this file
			"summary": { "errors": 1, "warnings": 0 },
			"diagnostics": [
				{
					"ruleId": "media/undeclared-ref",
					"severity": "error", // error | warning
					"message": "...",
					"fix": "...", // always filled
					"range": {
						// null without a position
						"line": 9,
						"column": 30,
						"endLine": 9,
						"endColumn": 40,
						"offset": 211,
						"endOffset": 221
					},
					"excerpt": "\"foto.JPG\"", // up to 120 characters of the input, or null
					"pointer": "/body/2/ref" // JSON Pointer into the submission, or null
				}
			],
			"specCheck": null // { dir, schemaSha256, openapiSha256, matchesTested } with --spec-dir
		}
	]
}
```

Lines and columns are 1-based, `offset` 0-based into the input. Columns and offsets count UTF-16 code units, as JavaScript strings do, and the end is exclusive: `endOffset - offset` is the length of `excerpt` when it is not cut short. The root of the submission has pointer `""`; `null` means the diagnostic is about no one place.

Diagnostics are sorted by position, those without a position last. A missing property points at the object that lacks it; an unknown or duplicate property points at its name. The output is deterministic. A breaking change to this shape raises `formatVersion`.

## Rules

```sh
bunx github:oszuidwest/lox-validator#v0.0.1 rules [--format json]
bunx github:oszuidwest/lox-validator#v0.0.1 explain media/undeclared-ref [--format json]
bunx github:oszuidwest/lox-validator#v0.0.1 --version
```

A file literally named `rules` or `explain` is reachable as `./rules`. Each rule names its `basis`: the submission API, the article schema, JSON itself, or a consistency rule of this validator that the documents do not state.

## Library

```ts
import { validate } from "lox-validator";
const result = validate(jsonText, { specDir: "/path/to/documents" });
```

`validate` takes the JSON as text, so it can report duplicate keys and positions. It throws only for unreadable or broken LOX documents.

## Contributing

- Run `bun run check` before you commit. `bun run fix` handles formatting.
- `spec/` holds the LOX schema and OpenAPI document this version is tested against, unchanged. Never edit them; a new LOX version replaces both files and the hashes in `src/spec-documents.ts`. Only these two documents belong there. Fixtures are synthetic.
- Bun is required, at the version in `engines` or newer: the CLI, the tests and CI all run on it.
- The conformance tests run against `spec/` in every `bun test`, CI included.
- The built-in rules must be at least as strict as both documents. A value either document rejects must never pass.
- Severity lives in the rule catalog (`src/rules.ts`) only.
- When you change the JSON report, change this file with it: `test/cli.test.ts` checks the example report here against the CLI, and the `notChecked` list against `NOT_CHECKED`.
