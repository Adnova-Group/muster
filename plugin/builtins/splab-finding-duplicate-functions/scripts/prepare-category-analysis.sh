#!/usr/bin/env bash
# Adapted by Muster from obra/superpowers-lab @ 51111f74f24058117752d9aa917cb19859f8ec86 (MIT): security hardening of the category split (see the comment above the loop; no tab/line splitting or arithmetic on model output, sanitized file names, no write through a symlinked output file).
# ABOUTME: Prepares category-specific function lists for duplicate detection
# Takes categorized output and splits into per-category files for Opus analysis

set -euo pipefail

usage() {
    cat <<EOF
Usage: $(basename "$0") <categorized.json> [output-dir]

Split categorized function catalog into per-category files for duplicate analysis.

ARGUMENTS:
    categorized.json    Output from categorization phase
    output-dir          Directory for category files (default: ./categories)

OUTPUT:
    Creates one JSON file per category (e.g., validation.json, string-utils.json)
    Only creates files for categories with 3+ functions (worth analyzing)

EXAMPLE:
    $(basename "$0") categorized.json ./analysis
    # Creates: ./analysis/validation.json, ./analysis/file-ops.json, etc.
EOF
    exit 0
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
fi

if [[ -z "${1:-}" ]]; then
    echo "Error: categorized.json required" >&2
    usage
fi

CATEGORIZED="$1"
OUTPUT_DIR="${2:-./categories}"

if [[ ! -f "$CATEGORIZED" ]]; then
    echo "Error: file not found: $CATEGORIZED" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Get category counts and filter to those with 3+ functions
echo "Analyzing categories..." >&2

# Muster hardening: category names (and anything else in categorized.json) come from model
# output over the scanned, untrusted code. The 3+ filter runs inside jq; the shell loops over
# NUL-separated category names only, never splits model text on tabs or newlines, never
# evaluates it arithmetically, prints it only JSON-encoded, and sanitizes it to
# [A-Za-z0-9._-] (never a leading dot) before it becomes a file name.
jq -r '
    group_by(.category | tostring) | map(select(length < 3)) | .[] |
    "  \(.[0].category | tostring | @json): \(length) functions (skipped, < 3)"
' "$CATEGORIZED" >&2

jq -j '
    group_by(.category | tostring) | map(select(length >= 3)) | sort_by(-length) | .[] |
    (.[0].category | tostring) | select(contains("\u0000") | not) | . + "\u0000"
' "$CATEGORIZED" | while IFS= read -r -d '' category; do
    safe="${category//[^A-Za-z0-9._-]/-}"
    if [[ -z "$safe" || "$safe" == .* ]]; then safe="category-${safe}"; fi
    outfile="$OUTPUT_DIR/${safe}.json"
    if [[ -L "$outfile" ]]; then echo "Error: refusing to write through a symlink: $outfile" >&2; exit 1; fi
    jq --arg cat "$category" '[.[] | select((.category | tostring) == $cat)]' "$CATEGORIZED" > "$outfile"
    count="$(jq 'length' "$outfile")"
    [[ "$count" =~ ^[0-9]+$ ]] || count="?"
    printf '  %s: %s functions -> %s\n' "$(jq -rn --arg c "$category" '$c | @json')" "$count" "$outfile" >&2
done

echo "" >&2
echo "Category files created in $OUTPUT_DIR" >&2
echo "Run Opus duplicate detection on each file with 3+ functions" >&2
