// FTS5 query helpers — shared by lib/tickets.ts and lib/conversation.ts.

// Wrap a user query as an FTS5 phrase literal. A bare hyphenated token ("follow-up")
// or a token with punctuation ("Alex's") is otherwise parsed by the FTS5 query grammar
// as a column filter / NOT expression and errors. Wrapping in double quotes (and escaping
// embedded double quotes) makes the whole string a literal phrase match.
// Empty/whitespace input is handled by the caller (falls back to the non-FTS query).
export function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}
