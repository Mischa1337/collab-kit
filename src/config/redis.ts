import Redis from 'ioredis';
import { logger } from './logger';

export const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  lazyConnect: true,
});

export const subscriber = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  lazyConnect: true,
});

export const connectRedis = async (): Promise<void> => {
  await redis.connect();
  await subscriber.connect();

  // Nachweis dass Pub/Sub funktioniert.
  // once() statt on() — der Handler feuert genau einmal und entfernt sich selbst.
  // Zusätzlich: Kanal-Filter, damit keine echten Session-Messages unsubscribed werden.
  await subscriber.subscribe('health-check');
  subscriber.once('message', (channel, message) => {
    if (channel === 'health-check' && message === 'ping') logger.info('Redis Pub/Sub: ✓');
    subscriber.unsubscribe('health-check');
  });
  await redis.publish('health-check', 'ping');

  logger.info('Redis verbunden');
};

