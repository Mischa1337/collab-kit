// Einheitliches Parsen von limit/offset aus Query-Parametern — vorher mehrfach
// identisch in chat/changelog/history dupliziert.
export interface Pagination { limit: number; offset: number; }

export function parsePagination(
  query: { limit?: unknown; offset?: unknown },
  def = 50,
  max = 200,
): Pagination {
  const limit = Math.min(Math.max(Number(query.limit ?? def), 1), max);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  return { limit, offset };
}
