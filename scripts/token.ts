/**
 * Mints a token for development, playing the part of a docking tool. Deliberately a
 * script and not a route: the service must never be able to issue an identity.
 *
 *   npm run token -- alice
 *   npm run token -- bob "Bob Beispiel" 5m
 */
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

import { isTokenAlgorithm, usesSharedSecret } from '../src/auth/token.ts';

const [subject, name, lifetime] = process.argv.slice(2);

if (subject === undefined || subject === '') {
  console.error('usage: npm run token -- <actor> [name] [lifetime, default 15m]');
  process.exit(1);
}

const secret = process.env['JWT_SECRET'];
if (secret === undefined || secret === '') {
  console.error('JWT_SECRET is missing, copy .env.example to .env first');
  process.exit(1);
}

// Only an HS algorithm can be minted here. For any other the private key stays with the
// tool, neither the service nor its scripts ever hold it.
const algorithm = process.env['JWT_ALGORITHM']?.trim() || 'HS256';
if (!isTokenAlgorithm(algorithm) || !usesSharedSecret(algorithm)) {
  console.error(`cannot mint ${algorithm} tokens, only HS256, HS384 and HS512`);
  process.exit(1);
}

const options: SignOptions = {
  algorithm,
  // The type is a template literal union such as '15m', a plain string needs the cast.
  expiresIn: (lifetime ?? '15m') as NonNullable<SignOptions['expiresIn']>,
};

// The same claims the service reads, so a token minted here passes there.
const actorClaim = process.env['ACTOR_CLAIM']?.trim() || 'sub';
const labelClaim = process.env['LABEL_CLAIM']?.trim() || 'name';

const token = jwt.sign({ [actorClaim]: subject, [labelClaim]: name ?? subject }, secret, options);

console.log(token);
