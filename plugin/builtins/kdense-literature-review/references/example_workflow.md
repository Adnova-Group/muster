<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: upstream supporting reference (K-Dense-AI/scientific-agent-skills) loaded inside its parent builtin, which supplies the role and output format; merge-tracked in vendor/manifest.yaml. -->

# Example Workflow

Illustrative end-to-end recipe, not an executed review. Run from the skill directory; populate the protocol, normalized search records, bibliography, and CSL file before the dependent commands. Dates below are a deliberately historical 2015-2024 interval.

## Example Workflow

Complete workflow for a biomedical literature review:

```bash
# 1. Create review document from template
mkdir -p sources styles
cp assets/review_template.md crispr_sickle_cell_review.md

# 2. Optional supplementary discovery: run academic-filtered and general web
#    searches with the harness's search tool; save each query, engine, date and
#    the returned hits under sources/ (a ranked sample, not a complete search)

# 3. Search specialized databases using appropriate skills
# - Use PubMed E-utilities and bioRxiv/medRxiv search or date-metadata APIs
# - Use direct API access for arXiv, Semantic Scholar
# - Save all pages and counts; document any API caps or failed requests
# - Normalize into a JSON array; keep raw exports and provenance

# 4. Process your normalized combined_results.json; raw API envelopes will fail
python scripts/search_databases.py combined_results.json \
  --deduplicate \
  --year-start 2015 \
  --year-end 2024 \
  --format markdown \
  --output search_results.md \
  --summary

# 5. Screen results and extract data
# - Request extracts with --full-content; obtain original reports and record failures
# - Use independent final full-text decisions and retain exclusion reasons
# - Track records, reports, studies, and overlapping participants separately
# - Extract key data into the review document
# - Organize by themes

# 6. Write the review following template structure
# - Introduction with clear objectives
# - Detailed methodology section
# - Results organized thematically
# - Critical discussion
# - Clear conclusions

# 7. Check DOI registration/metadata, then manually verify identity and claim support
python scripts/verify_citations.py crispr_sickle_cell_review.md

# Review the citation report
cat crispr_sickle_cell_review_citation_report.json

# Investigate missing/inconclusive results; transient failures do not invalidate citations
python scripts/verify_citations.py crispr_sickle_cell_review.md

# 8. Render after supplying bibliography, local CSL, and [@key] citations
# For manually typed references, omit those options; text will not be restyled
python scripts/generate_pdf.py crispr_sickle_cell_review.md \
  --bibliography crispr_sickle_cell_review.bib --csl styles/nature.csl \
  --output crispr_sickle_cell_review.pdf

# 9. Review final PDF and markdown outputs
```
