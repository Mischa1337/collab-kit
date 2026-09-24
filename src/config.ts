/**
 * Runtime configuration, read once at startup. A missing or malformed variable fails
 * immediately instead of surfacing on the first request.
 */
import { isTokenAlgorithm, TOKEN_ALGORITHMS, usesSharedSecret } from './auth/token.ts';
import type { TokenAlgorithm } from './auth/token.ts';

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
}

const PLACEHOLDER_SECRET = 'replace-me-locally';

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

  if (problems.length > 0) {
    throw new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }

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

function requireValue(env: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const value = optionalValue(env, name);
  if (value === undefined) {
    problems.push(`${name} is missing`);
    return '';
  }
  return value;
}
