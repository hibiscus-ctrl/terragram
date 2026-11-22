type JsonLdData = Record<string, unknown>;

/**
 * Emits a JSON-LD <script> for structured data. Server-rendered inline so the
 * markup is in the initial HTML (crawlers and AI answer engines see it without
 * executing JS). Pass a single schema or an array; data is our own static
 * content, and `<` is escaped so a stray "</script>" can't break out.
 */
export function JsonLd({ data }: { data: JsonLdData | JsonLdData[] }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: only way to inline JSON-LD; data is static and `<` is escaped
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
