/**
 * Defensive sanitization for user-generated text (chat messages, display names).
 *
 * We store plain text only — no HTML, no attributes, no scripts. The strip is
 * applied both on the way in (API route) and on the way out (render) so a
 * stored payload that somehow bypassed one layer is still inert on render.
 */
export function sanitizeText(input: string, maxLen = 500): string {
  if (typeof input !== "string") return "";
  // Collapse any tag-like sequence to nothing, decode-then-encode HTML
  // entities, and trim whitespace. Also strips control chars.
  const noTags = input.replace(/<[^>]*>/g, "");
  const noControl = noTags.replace(/[\u0000-\u001F\u007F]/g, "");
  const escaped = noControl
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return escaped.slice(0, maxLen).trim();
}

/**
 * Second-pass render-time escape. Even if a row was stored before this app
 * existed or through a different path, this guarantees safe insertion into HTML.
 */
export function escapeForRender(input: string): string {
  return (input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
