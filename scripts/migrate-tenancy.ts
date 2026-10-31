// npm run migrate:tenancy — pasa una instalación existente a multi-tenant.
// Es repetible: si ya está migrada, no hace nada. Respalda antes de mover.
import { migrateTenancy } from '../src/tenancy/migrate.ts';
import { closeDb, dbEnabled } from '../src/db/pool.ts';

try {
  const r = await migrateTenancy((m) => console.log(m));
  for (const s of r.steps) console.log(`✔ ${s}`);
  for (const w of r.warnings) console.log(`⚠ ${w}`);
  console.log('Migración multi-tenant terminada.');
} catch (err) {
  console.error(`✖ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  if (dbEnabled) await closeDb();
}
