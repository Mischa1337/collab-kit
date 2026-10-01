/** Runtime configuration, read once at startup so a bad variable fails right away. */
import { isTokenAlgorithm, TOKEN_ALGORITHMS, usesSharedSecret } from './auth/token.ts';
import type { TokenAlgorithm } from './auth/token.ts';
import { defined } from './utils/optional.ts';

const NODE_ENVS = ['development', 'test', 'production'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

export interface Config {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: string;
  readonly mongoUri: string;
  readonly mongoDb: string;
  readonly jwtAlgorithm: TokenAlgorithm;
  /** JWT_SECRET for an HS algorithm, JWT_PUBLIC_KEY for any other. */
  readonly jwtKey: string;
  /** Seconds an expired token is still accepted, to absorb clock drift between the machines. */
  readonly jwtClockTolerance: number;
  /** Claim that holds the actor key. Set per instance, never per request. */
  readonly actorClaim: string;
  /** Claim that holds the name to show. */
  readonly labelClaim: string;
  /** Largest WebSocket message; left out, the gateway keeps its own default. */
  readonly maxMessageBytes?: number;
  /** Largest awareness update; left out, the gateway keeps its own default. */
  readonly maxAwarenessBytes?: number;
  /** Web origins that may open a WebSocket or call the routes; left out, every origin may. */
  readonly allowedOrigins?: readonly string[];
}

/** An origin as a browser sends it: scheme and host, maybe a port, no path. */
const ORIGIN = /^https?:\/\/[^/\s]+$/;

/** MongoDB keeps at most 16 MiB in one document, and one change is one document. */
const MAX_MESSAGE_LIMIT = 15 * 1024 * 1024;

/** The example secret from .env.example, refused in production. */
const PLACEHOLDER_SECRET = 'replace-me-locally';

/** Checks every variable, then throws once with all problems found. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const nodeEnv = env['NODE_ENV']?.trim() ?? 'development';
  if (!isNodeEnv(nodeEnv)) {
    problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}, got "${nodeEnv}"`);
  }

  const portRaw = env['PORT']?.trim() ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be a port number, got "${portRaw}"`);
  }

  const mongoUri = requireValue(env, 'MONGODB_URI', problems);
  const mongoDb = requireValue(env, 'MONGODB_DB', problems);

  const jwtAlgorithm = optionalValue(env, 'JWT_ALGORITHM') ?? 'HS256';
  if (!isTokenAlgorithm(jwtAlgorithm)) {
    problems.push(
      `JWT_ALGORITHM must be one of ${TOKEN_ALGORITHMS.join(', ')}, got "${jwtAlgorithm}"`,
    );
  }

  const jwtKeyName = usesSharedSecret(jwtAlgorithm) ? 'JWT_SECRET' : 'JWT_PUBLIC_KEY';
  const jwtKey = requireValue(env, jwtKeyName, problems);

  if (nodeEnv === 'production' && jwtKey === PLACEHOLDER_SECRET) {
    problems.push(`${jwtKeyName} still holds the example placeholder`);
  }

  const toleranceRaw = optionalValue(env, 'JWT_CLOCK_TOLERANCE') ?? '5';
  const jwtClockTolerance = Number(toleranceRaw);
  if (!Number.isInteger(jwtClockTolerance) || jwtClockTolerance < 0) {
    problems.push(`JWT_CLOCK_TOLERANCE must be whole seconds from 0, got "${toleranceRaw}"`);
  }

  const maxMessageBytes = optionalBytes(env, 'MAX_MESSAGE_BYTES', problems);
  const maxAwarenessBytes = optionalBytes(env, 'MAX_AWARENESS_BYTES', problems);
  const allowedOrigins = optionalOrigins(env, problems);

  if (problems.length > 0) {
    throw new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }

  // The casts are safe: an invalid value would have thrown above.
  return {
    nodeEnv: nodeEnv as NodeEnv,
    port,
    logLevel: env['LOG_LEVEL']?.trim() ?? 'info',
    mongoUri,
    mongoDb,
    jwtAlgorithm: jwtAlgorithm as TokenAlgorithm,
    jwtKey,
    jwtClockTolerance,
    // The standard claims of RFC 7519 and OpenID Connect, for a tool that follows them.
    actorClaim: optionalValue(env, 'ACTOR_CLAIM') ?? 'sub',
    labelClaim: optionalValue(env, 'LABEL_CLAIM') ?? 'name',
    ...defined({ maxMessageBytes, maxAwarenessBytes, allowedOrigins }),
  };
}

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(value);
}

/** The trimmed value, or undefined when the variable is missing or blank. */
function optionalValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === '' ? undefined : value;
}

/** A size in whole bytes up to 15 MiB, undefined when not set; anything else is a problem. */
function optionalBytes(
  env: NodeJS.ProcessEnv,
  name: string,
  problems: string[],
): number | undefined {
  const raw = optionalValue(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const bytes = Number(raw);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_MESSAGE_LIMIT) {
    problems.push(`${name} must be whole bytes from 1 to 15 MiB, got "${raw}"`);
  }
  return bytes;
}

/** ALLOWED_ORIGINS as a list, undefined when blank; a malformed origin is a problem. */
function optionalOrigins(env: NodeJS.ProcessEnv, problems: string[]): string[] | undefined {
  const origins = (optionalValue(env, 'ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  // A trailing slash or a path never matches what a browser sends, so it fails at the start.
  const malformed = origins.filter((origin) => !ORIGIN.test(origin));
  if (malformed.length > 0) {
    problems.push(
      `ALLOWED_ORIGINS must list origins like https://tool.example, got "${malformed.join(', ')}"`,
    );
  }
  return origins.length === 0 ? undefined : origins;
}

/** Like optionalValue, but records a missing variable as a problem. */
function requireValue(env: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const value = optionalValue(env, name);
  if (value === undefined) {
    problems.push(`${name} is missing`);
    return '';
  }
  return value;
}
