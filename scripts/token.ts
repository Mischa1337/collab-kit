/**
 * Mints a token for development, playing the part of a docking tool. Deliberately a
 * script and not a route: the service must never be able to issue an identity.
 *
 *   npm run token -- alice
 *   npm run token -- bob "Bob Beispiel" 5m
 */
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

const [subject, name, lifetime] = process.argv.slice(2);

if (subject === undefined || subject === '') {
  console.error('usage: npm run token -- <sub> [name] [lifetime, default 15m]');
  process.exit(1);
}

const secret = process.env['JWT_SECRET'];
if (secret === undefined || secret === '') {
  console.error('JWT_SECRET is missing, copy .env.example to .env first');
  process.exit(1);
}

const options: SignOptions = {
  algorithm: 'HS256',
  // The type is a template literal union such as '15m', a plain string needs the cast.
  expiresIn: (lifetime ?? '15m') as NonNullable<SignOptions['expiresIn']>,
};

const token = jwt.sign({ sub: subject, name: name ?? subject }, secret, options);

console.log(token);
