// Raíz del proyecto. Va aparte (sin dependencias) para poder importarla desde
// cualquier sitio sin ciclos.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
