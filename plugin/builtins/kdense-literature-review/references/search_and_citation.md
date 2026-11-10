<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: upstream supporting reference (K-Dense-AI/scientific-agent-skills) loaded inside its parent builtin, which supplies the role and output format; merge-tracked in vendor/manifest.yaml. -->

# Search, citation chaining, and source verification

Use [database_strategies.md](database_strategies.md) for current request syntax,
authentication, response shapes, and paging limits. Commands below are
illustrative discovery recipes, not executed searches or complete corpora.

## Supplementary web search

Use the harness's web search and fetch tools for supplementary discovery: academic domain filters for scholarly coverage, and a fetch of an accessible paper URL when you need its full text. For every search, save each query, the engine, the date and the returned hits under `sources/`; a ranked web sample is a lead list, never a complete search.

A search tool's result limit caps the ranked hits it returns, not the database total. A fetched page can be partial or truncated, and partial or truncated content
still requires retrieval from the original source. Save the URL, extraction
status, date, and exact text supporting each inference. Never report a title,
web excerpt, or machine summary as if the full paper was assessed.

## Citation chaining

- **Forward:** use Google Scholar Cited by or documented Semantic Scholar /
  OpenAlex citation queries. Search-engine queries such as "papers citing ..."
  are supplementary leads, not complete forward-citation exports.
- **Backward:** inspect reference lists of eligible reports and relevant reviews;
  retrieve candidate records and apply the same eligibility criteria.
- Track seed papers, tools, dates, retrieved counts, and screening decisions.
  Link preprint, journal, protocol, and follow-up reports to a study ID before
  synthesis. Citation-count thresholds and journal prestige are not eligibility
  rules; recent and negative studies must have an equal chance of inclusion.

## DOI checks and bibliographic identity

```bash
python scripts/verify_citations.py review.md --output review_citation_report.json
```

Optional `--email` supplies a real contact to the Crossref polite pool. The
helper extracts unique DOI candidates, URL-encodes them, and checks
`GET https://doi.org/api/handles/{doi}`. Registration requires a successful
Handle `responseCode=1` and matching identifier, not HTTP 200 alone. It then
requests `GET https://api.crossref.org/works/{doi}` and checks metadata identity.
These public singleton reads require no key or pagination.

Read the report's `verified` as **registration confirmed**, `failed` as
**unresolved/missing/inconclusive**, and `metadata_unavailable` as **manual
metadata follow-up needed**. Transient errors and throttling are not proof of
fabrication. Crossref does not cover every registration agency. The script
preserves the original Crossref message and full author list; its compatibility
formatting methods are previews, not compliant APA or Nature output.

DOI extraction is heuristic: inspect ambiguous trailing punctuation and older
suffixes with parentheses. Citations without DOIs require manual verification.
Check titles, authors, year, version, correction/retraction notices, and that
the source actually supports the cited statement. Registered identifiers and
accessible URLs do not establish those properties.

Sources: [Handle proxy API](https://www.handle.net/proxy_servlet.html),
[Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/).

## Rendering references

Use complete metadata in BibTeX/CSL JSON and a current, venue-appropriate CSL
file. See [citation_styles.md](citation_styles.md). With Pandoc, cite using
`[@citation_key]`; manually typed reference strings are not reformatted by
selecting a style.

```bash
# Requires your populated review.bib and local styles/apa.csl.
python scripts/generate_pdf.py review.md --bibliography review.bib \
  --csl styles/apa.csl --output review.pdf
```

No CSL files are bundled or downloaded automatically. A sibling `.bib` is
recognized; otherwise provide `--bibliography` or Pandoc bibliography metadata.
Omitting `--csl` uses Pandoc's default citation style. `--citation-style` remains
an alias for a local file/name (e.g. `apa` requires `apa.csl`).

Inspect the rendered PDF and all warnings, including unresolved keys. Match
in-text citations to the bibliography and manually verify formatting against
the destination journal's instructions. [Pandoc citation documentation](https://pandoc.org/MANUAL.html#citations).
