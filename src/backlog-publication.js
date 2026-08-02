// Backlog publication accepts complete staged files up to 16 MiB through every
// transport. Keep this byte limit independent from character-count schemas:
// UTF-8 content is checked at the CLI/tool boundary before it reaches disk.
export const BACKLOG_PUBLICATION_MAX_BYTES = 16 * 1_048_576;
