// Uso: npm run import -- ruta/a/Solucion.zip   (o carpeta descomprimida, o tema.yaml)
import { importPath } from './importer.ts';

const path = process.argv[2];
if (!path) {
  console.error('Uso: npm run import -- <solucion.zip | carpeta | tema.yaml>');
  process.exit(1);
}
const report = await importPath(path);
for (const a of report.agents) console.log(`✔ ${a.name} (${a.id}): ${a.topics} temas, ${a.knowledge} fuentes, ${a.actions} acciones`);
for (const w of report.warnings) console.log(`⚠ ${w}`);
