# LOX validator

Checks whether an article in LOX JSON is correct before it goes to LOX, the article platform of the NLPO pilot for local broadcasters. The input is the JSON you send to `POST /api/v1/article`: an `ArticleSubmission`. The validator is built mainly for agents that submit articles: they run it, read the JSON output, fix the article and run it again. The workflow for agents is in [`AGENTS.md`](AGENTS.md).

> **Status: LOX is a draft.** This version follows LOX v1 with API version 1.0.0, dated 28 October 2026. The schema and OpenAPI document of that version are in [`spec/`](spec/). If the format changes, the rules may be out of date.

## What does it check?

LOX has two documents: the OpenAPI description of the API, with what a broadcaster sends, and the schema of the article as LOX stores it after processing. The validator checks a submission against the strictest reading of the two together:

- **The format**: required fields, lengths, counts, patterns such as file names and MIME types, dates with a time zone, URLs, and the allowed blocks, inline elements, marks and delivery methods. Where the API allows a number and the schema requires an integer, the integer wins. An empty list item is an error.
- **Consistency**: every `ref` in the hero and the body has a declaration in `media`, no duplicate refs, an `image` block does not point at audio, `upload` delivery has `byteSize` and `checksum` but no `url`, and `url` delivery does not point at an internal address such as `127.0.0.1`, `192.168.x.x` or `nas.local`.
- **JSON itself**: valid JSON per RFC 8259, without comments or trailing commas, and without duplicate keys. With a duplicate key, a regular parser silently keeps only the last one.
- **What the format allows but loses content**: unknown fields, such as a typo `captoin` (with a suggestion), HTML leftovers such as `<b>` or `&amp;` in text, hard line breaks in a text run, paragraphs of only spaces, and unused media.

| Severity  | Meaning                                                  | Exit code |
| --------- | -------------------------------------------------------- | --------- |
| `error`   | LOX refuses this, or the article is inconsistent         | 1         |
| `warning` | Goes through, but something is likely wrong or gets lost | 0         |

Exit code 2 means nothing was judged: a wrong option, an unreadable file or an internal failure.

## Install

You need [Bun](https://bun.sh) 1.2.18 or newer.

```sh
git clone https://github.com/oszuidwest/lox-validator.git
cd lox-validator
bun install
```

From another repository, use a version tag. Without a tag, `bunx` silently keeps running the version it cached first, even with `#main`:

```sh
bunx github:oszuidwest/lox-validator#v0.0.1 article.json
# or from a local checkout, after `bun install`:
bun /path/to/lox-validator/src/cli.ts article.json
```

## Usage

```sh
bun src/cli.ts article.json
```

```text
article.json:9:30  error  media/undeclared-ref  image block uses ref "foto.JPG", which has no declaration in media
  fix: Add a media declaration with this ref, or correct the ref. Refs are case-sensitive.
article.json:9:42  warning  format/unknown-property  "captoin" is not a field here; did you mean "caption"?
  fix: Rename "captoin" to "caption".
article.json:11:34  error  format/violation  heading level must be a whole number; it is 1.5
  fix: Change the value at the pointer as the message says.
2 errors, 1 warning in 1 file
```

`--format json` gives the same as JSON. One diagnostic looks like this:

```json
{
	"ruleId": "media/undeclared-ref",
	"severity": "error",
	"message": "image block uses ref \"foto.JPG\", which has no declaration in media",
	"fix": "Add a media declaration with this ref, or correct the ref. Refs are case-sensitive.",
	"range": {
		"line": 9,
		"column": 30,
		"endLine": 9,
		"endColumn": 40,
		"offset": 211,
		"endOffset": 221
	},
	"excerpt": "\"foto.JPG\"",
	"pointer": "/body/2/ref"
}
```

The full report is documented in [`AGENTS.md`](AGENTS.md). A valid example article is in [`examples/article.json`](examples/article.json).

| Option                | Meaning                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `-`                   | Read from stdin                                                               |
| `--format text\|json` | Output format; default `text`                                                 |
| `--spec-dir <dir>`    | Also check against the LOX documents in this directory, or set `LOX_SPEC_DIR` |

`bun src/cli.ts rules` lists all rules and `bun src/cli.ts explain media/undeclared-ref` explains one, both also with `--format json`.

## Choices

**The submission, not the stored article.** According to the LOX technical overview, the schema describes the article as LOX stores it after receipt, and the OpenAPI document what a broadcaster sends. So the validator checks an `ArticleSubmission`. LOX sets `formatVersion`, `contentType` and `loxId` itself, and `extensions` and `sourceIds` (on media) exist only in the schema. If they are present, the warning `format/not-in-submission` follows, and their values are still checked.

**Strictest reading.** Where the API and the schema differ, the stricter one applies. Where the documents give a rule only in prose, such as "Required for upload delivery", it is a rule of its own with that text as its basis. Rules that are stated nowhere but follow from consistency, such as a `video` block that points at audio, are in the catalog as rules of this validator. `explain` shows the basis of each rule.

**Unknown fields.** The schema allows unknown fields, but does not say what LOX does with them. So they give a warning, not an error: otherwise a typo in an optional field would not do what was meant, and nothing would say so.

## What the validator does not do

`ok: true` means the submission fits the format and is consistent. Nothing more. It does not mean LOX accepts the article. The validator makes no network requests and does not check:

- **Media on the network**: whether a URL is reachable and public, including whether an ordinary host name resolves to an internal address, which MIME type it really returns, and whether it redirects
- **File against declaration**: whether `byteSize` and `checksum` match the file
- **Uploading** media with `upload` delivery
- **Links and embeds**: whether a link or embed points at something that exists
- **Refs across articles**: a `ref` should be unique and stable per broadcaster; the validator sees one article at a time
- **Rights**
- **The tenant header and authentication**
- **Whether the LOX server accepts the article**

This list is also in the JSON, as `notChecked`.

## The LOX documents

The validator works with its built-in rules; it does not need the documents. The tests keep those rules at least as strict as the versions in `spec/`. With `--spec-dir` you also check a submission against the documents in a directory, such as a newer version:

```sh
bun src/cli.ts --spec-dir /path/to/documents article.json
```

- What only the documents reject becomes `spec/violation`
- If the documents differ from the versions the validator was tested with, the warning `spec/changed` follows. It means the rules may be out of date, not that the newer version is supported
- In this version, the OpenAPI document rejects every paragraph, quote, media item and text run, because its `oneOf` alternatives overlap. The validator repairs that by tying each alternative to its `type`, `method` or `algorithm`. That is our reading of what is meant
- If the validator cannot apply the documents in full, it stops with exit code 2
- `--spec-dir ""` is a usage error. An empty `LOX_SPEC_DIR` counts as unset
- Passing this check still does not tell you whether the server accepts the article

## Development

```sh
bun run check   # Biome, tsc and the tests, including the conformance tests against spec/
```

Test data is made up; it contains no content from real articles.

## License

[GNU Affero General Public License v3.0](LICENSE)
