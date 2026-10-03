# Legal documents published on termhub.dev

The pages `termhub.dev/termos/` and `termhub.dev/privacidade/` are rendered at build time from the files in this folder:

| File | Page |
|---|---|
| `termos-de-uso.md` | `/termos/` |
| `politica-de-privacidade.md` | `/privacidade/` |

The text is written in Portuguese (pt-BR) and reviewed by a lawyer before it is published. Review-only material stays in the file and is dropped from the page by `src/legal/render.ts`: the `> **RASCUNHO PARA REVISÃO JURÍDICA…**` header and every `> Nota:` block. Links between the two documents become links between the pages; links to other review files (`comparativo.md`, `duvidas-advogado.md`) become plain text.

## Status

`src/legal/documents.ts` holds each document's status:

- `draft`: the page shows a "Rascunho" banner saying the text is not in force, and the HTML entry (`termos/index.html`, `privacidade/index.html`) carries `noindex`.
- `published`: the text was approved by the lawyer and by the maintainer.

## Publishing a version

1. Replace the `.md` file with the approved text and fill in its "Versão" and "Vigência" lines.
2. In `src/legal/documents.ts`, set `status: 'published'` and add `{ version, date, summary }` at the top of `history`.
3. In the HTML entry, change the robots meta to `index, follow`, and add the page to `public/sitemap.xml`.
4. `npm test -w @termhub/landing` checks that steps 2 and 3 agree.

Before replacing a published version, copy it to `archive/<file>-v<version>.md` so the previous versions stay on record.
