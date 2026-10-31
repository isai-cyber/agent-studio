// Uso: npm run import -- ruta/a/Solucion.zip [--tenant <id>]   (o carpeta descomprimida, o tema.yaml)
// Sin --tenant se importa en la empresa Default (id 1).
import { importPath } from './importer.ts';

const args = process.argv.slice(2);
const t = args.indexOf('--tenant');
const tenantId = t >= 0 ? Number(args.splice(t, 2)[1]) : 1;
const path = args[0];
if (!path || !Number.isInteger(tenantId) || tenantId <= 0) {
  console.error('Uso: npm run import -- <solucion.zip | carpeta | tema.yaml> [--tenant <id>]');
  process.exit(1);
}
const report = await importPath(tenantId, path);
for (const a of report.agents) console.log(`✔ ${a.name} (${a.id}): ${a.topics} temas, ${a.knowledge} fuentes, ${a.actions} acciones`);
for (const w of report.warnings) console.log(`⚠ ${w}`);
