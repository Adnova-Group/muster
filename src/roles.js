// Single source of truth for the role vocabulary. Imported as an array by
// capabilities.js (iteration order matters) and wrapped in a Set by catalog.js
// (membership checks). Keep this the only place the 25 roles are listed.
export const ROLES = [
  "code-navigation", "docs-research", "brainstorm", "plan", "implement",
  "code-review", "security-review", "test-author", "refactor", "frontend", "tech-debt", "debug",
  "author", "research", "score",
  "architecture-review", "browser-control", "computer-control",
  "performance", "seo", "humanize", "prompt-quality", "improve",
  "image", "video"
];
