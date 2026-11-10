#!/usr/bin/env bash
# Adapted by Muster from obra/superpowers-lab @ 51111f74f24058117752d9aa917cb19859f8ec86 (MIT): the per-file counts are checked to be plain integers before bash arithmetic; model-written text is Markdown-escaped and a symlinked output path is refused.
# ABOUTME: Generates human-readable duplicate detection report from Opus analysis output
# Combines per-category duplicate findings into a prioritized markdown report

set -euo pipefail

usage() {
    cat <<EOF
Usage: $(basename "$0") <duplicates-dir> [output-file]

Generate markdown report from duplicate detection results.

ARGUMENTS:
    duplicates-dir    Directory containing per-category duplicate JSON files
    output-file       Output markdown file (default: duplicates-report.md)

INPUT FORMAT:
    Each JSON file should contain array of duplicate groups from Opus analysis.

EXAMPLE:
    $(basename "$0") ./duplicates ./duplicates-report.md
EOF
    exit 0
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
fi

if [[ -z "${1:-}" ]]; then
    echo "Error: duplicates directory required" >&2
    usage
fi

DUPLICATES_DIR="$1"
OUTPUT="${2:-duplicates-report.md}"

if [[ ! -d "$DUPLICATES_DIR" ]]; then
    echo "Error: directory not found: $DUPLICATES_DIR" >&2
    exit 1
fi

# Muster hardening: the report path may sit in an untrusted checkout; never write through a
# symlink planted there.
if [[ -L "$OUTPUT" ]]; then
    echo "Error: refusing to write the report through a symlink: $OUTPUT" >&2
    exit 1
fi

# Muster hardening: every field below is model output about untrusted code. `md` flattens it
# to one line and escapes HTML and Markdown syntax so it cannot add headings, links, images,
# tables or raw HTML to the report; `code` keeps a value inside its backtick code span.
JQ_ESCAPE='
def one: if . == null then "" else tostring end | gsub("[\r\n\t]+"; " ");
def md: one | gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;")
    | gsub("(?<c>[\\\\`*_\\[\\]!#|~])"; "\\\(.c)");
def code: one | gsub("`"; "'"'"'");
'

# Generate the report
{
    echo "# Duplicate Functions Report"
    echo ""
    echo "Generated: $(date '+%Y-%m-%d %H:%M')"
    echo ""

    # Count totals
    high_count=0
    medium_count=0
    low_count=0

    for f in "$DUPLICATES_DIR"/*.json; do
        [[ -f "$f" ]] || continue
        h=$(jq '[.[] | select(.confidence == "HIGH")] | length' "$f")
        m=$(jq '[.[] | select(.confidence == "MEDIUM")] | length' "$f")
        l=$(jq '[.[] | select(.confidence == "LOW")] | length' "$f")
        # Muster hardening: duplicates/*.json is model output; only a plain integer reaches
        # bash arithmetic (jq's length is one, but nothing else is ever evaluated).
        for n in "$h" "$m" "$l"; do [[ "$n" =~ ^[0-9]+$ ]] || { echo "Error: non-numeric count in $f" >&2; exit 1; }; done
        high_count=$((high_count + h))
        medium_count=$((medium_count + m))
        low_count=$((low_count + l))
    done

    echo "## Summary"
    echo ""
    echo "| Confidence | Count | Action |"
    echo "|------------|-------|--------|"
    echo "| HIGH | $high_count | Consolidate immediately |"
    echo "| MEDIUM | $medium_count | Investigate further |"
    echo "| LOW | $low_count | Review if time permits |"
    echo ""

    # HIGH confidence section
    echo "---"
    echo ""
    echo "## HIGH Confidence Duplicates"
    echo ""
    echo "These functions are definitely duplicates. Consolidate them."
    echo ""

    for f in "$DUPLICATES_DIR"/*.json; do
        [[ -f "$f" ]] || continue
        category=$(basename "$f" .json)

        jq -r --arg cat "$category" "$JQ_ESCAPE"'
            .[] | select(.confidence == "HIGH") |
            "### \(.intent | md)\n\n" +
            "**Category:** \($cat | md)\n\n" +
            "**Functions:**\n" +
            (.functions | map("- `\(.name | code)` in `\(.file | code):\(.line | code)`" + if .notes then " - \(.notes | md)" else "" end) | join("\n")) +
            "\n\n" +
            "**Differences:** \(.differences // "None - identical implementations" | md)\n\n" +
            "**Recommendation:** Keep `\(.recommendation.survivor | code)` - \(.recommendation.reason | md)\n\n" +
            "---\n"
        ' "$f" 2>/dev/null || true
    done

    # MEDIUM confidence section
    echo ""
    echo "## MEDIUM Confidence Duplicates"
    echo ""
    echo "These functions likely do the same thing. Investigate before consolidating."
    echo ""

    for f in "$DUPLICATES_DIR"/*.json; do
        [[ -f "$f" ]] || continue
        category=$(basename "$f" .json)

        jq -r --arg cat "$category" "$JQ_ESCAPE"'
            .[] | select(.confidence == "MEDIUM") |
            "### \(.intent | md)\n\n" +
            "**Category:** \($cat | md)\n\n" +
            "**Functions:**\n" +
            (.functions | map("- `\(.name | code)` in `\(.file | code):\(.line | code)`" + if .notes then " - \(.notes | md)" else "" end) | join("\n")) +
            "\n\n" +
            "**Differences:** \(.differences | md)\n\n" +
            "**Recommendation:** \(.recommendation.action | md) - \(.recommendation.reason | md)\n\n" +
            "---\n"
        ' "$f" 2>/dev/null || true
    done

    # LOW confidence section
    echo ""
    echo "## LOW Confidence (Possibly Related)"
    echo ""
    echo "These functions might be related. Review if time permits."
    echo ""

    for f in "$DUPLICATES_DIR"/*.json; do
        [[ -f "$f" ]] || continue
        category=$(basename "$f" .json)

        jq -r --arg cat "$category" "$JQ_ESCAPE"'
            .[] | select(.confidence == "LOW") |
            "### \(.intent | md)\n\n" +
            "**Category:** \($cat | md)\n\n" +
            "**Functions:**\n" +
            (.functions | map("- `\(.name | code)` in `\(.file | code):\(.line | code)`") | join("\n")) +
            "\n\n" +
            "**Notes:** \(.differences | md)\n\n" +
            "---\n"
        ' "$f" 2>/dev/null || true
    done

} > "$OUTPUT"

echo "Report generated: $OUTPUT" >&2
echo "  HIGH confidence: $high_count groups" >&2
echo "  MEDIUM confidence: $medium_count groups" >&2
echo "  LOW confidence: $low_count groups" >&2
