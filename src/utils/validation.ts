// Zentrale Validierungs-Helfer — eine Quelle der Wahrheit statt mehrfacher Kopien (R4).
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Type-Guard: true, wenn der Wert ein gültiger UUID-String ist.
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_REGEX.test(value);
