/**
 * Runtime configuration, read once at startup. A missing or malformed variable fails
 * immediately instead of surfacing on the first request.
 */

const NODE_ENVS = ['development', 'test', 'production'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

export interface Config {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: string;
  readonly mongoUri: string;
  readonly mongoDb: string;
  readonly jwtSecret: string;
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
  const jwtSecret = requireValue(env, 'JWT_SECRET', problems);

  if (nodeEnv === 'production' && jwtSecret === PLACEHOLDER_SECRET) {
    problems.push('JWT_SECRET still holds the example placeholder');
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
    jwtSecret,
  };
}

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(value);
}

function requireValue(env: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    problems.push(`${name} is missing`);
    return '';
  }
  return value;
}
