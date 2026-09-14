const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');
const { db } = require('./dist/config/db');

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = join(__dirname, 'db', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await db.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );

    if (rows.length > 0) {
      console.log(`Übersprungen (bereits ausgeführt): ${file}`);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    console.log(`Führe Migration aus: ${file}`);
    await db.query(sql);
    // ON CONFLICT: Starten mehrere Instanzen gleichzeitig gegen eine leere Datenbank,
    // schreiben beide denselben Dateinamen. Ohne diesen Zusatz stirbt die zweite am
    // Primärschlüssel, obwohl die Migration selbst erfolgreich war.
    await db.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      [file]
    );
    console.log(`✓ ${file} erfolgreich`);
  }

  await db.end();
  console.log('Alle Migrationen abgeschlossen.');
}

migrate().catch(err => {
  console.error('Migration fehlgeschlagen:', err.message);
  process.exit(1);
});