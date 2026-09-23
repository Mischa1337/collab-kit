import type { Document } from 'mongodb';

/** Every field of T optional, and none of them holding undefined. */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * The same fields without the undefined ones, to be spread into a record. Needed
 * because exactOptionalPropertyTypes lets an optional field be left out but never hold
 * undefined: `...defined({ label, reason })` keeps what is there and drops the rest.
 */
export function defined<T extends object>(fields: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}

/**
 * The filter on a field that may be absent, the reading side of the same thing.
 * undefined asks nothing about the field, null asks for it to be absent, and any other
 * value for exactly that value.
 */
export function matchOptional(field: string, value: unknown): Document {
  if (value === undefined) {
    return {};
  }
  return { [field]: value === null ? { $exists: false } : value };
}
