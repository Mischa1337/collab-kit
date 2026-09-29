import type { Document } from 'mongodb';

/** Like T, but every field optional and none of them allowed to hold undefined. */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Drops every field that is undefined, e.g. `...defined({ label, reason })`. */
export function defined<T extends object>(fields: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}

/** MongoDB filter: undefined = no filter, null = field is absent, else field equals value. */
export function matchOptional(field: string, value: unknown): Document {
  if (value === undefined) {
    return {};
  }
  return { [field]: value === null ? { $exists: false } : value };
}
