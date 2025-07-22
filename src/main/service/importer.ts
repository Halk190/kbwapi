import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';

type TipoCarta = 'BESTIA_NORMAL' | 'BESTIA_HABILIDAD' | 'CONJURO_NORMAL' | 'CONJURO_CAMPO' | 'RECURSO' | 'REINA' | 'TOKEN';

interface CartaBase {
  idFisico: string;
  nombre: string;
  descripcion: string;
  tipoCarta: TipoCarta;
  [key: string]: any;
}

let idGlobalCounter = 1;

export async function importarCartas(env: { DB: D1Database }) {
    const folderPath = 'src/resources/dataset';
      let totalNuevasCartas = 0;

      const files = readdirSync(folderPath).filter(f => f.endsWith('.csv'));

      for (const fileName of files) {
        const path = join(folderPath, fileName);
        const tipoCarta = detectarTipoPorNombreArchivo(fileName);

        const content = readFileSync(path, 'utf-8');
        const rows = parse(content, { columns: true, skip_empty_lines: true });

        let nuevas = 0;

        for (const row of rows) {
          const carta = crearCartaDesdeCsv(tipoCarta, row);
          if (!carta) continue;

          const existe = await cartaYaExiste(env, carta.idFisico, carta.nombre);
          if (!existe) {
            carta.idGlobal = generarIdGlobal(tipoCarta);
            await insertarCarta(env, tipoCarta, carta);
            nuevas++;
          }
        }

        totalNuevasCartas += nuevas;
        console.log(`✅ Importado: ${fileName} (${nuevas} nuevas cartas)`);
      }
      console.log(`🎉 Total de nuevas cartas añadidas: ${totalNuevasCartas}`);
}


// --- Utilidades ---

function detectarTipoPorNombreArchivo(nombre: string): TipoCarta {
  const n = nombre.toLowerCase();
  if (n.includes('habilidad')) return 'BESTIA_HABILIDAD';
  if (n.includes('normal')) return 'BESTIA_NORMAL';
  if (n.includes('campo')) return 'CONJURO_CAMPO';
  if (n.includes('recurso')) return 'RECURSO';
  if (n.includes('conjuro')) return 'CONJURO_NORMAL';
  if (n.includes('reina')) return 'REINA';
  if (n.includes('token')) return 'TOKEN';
  throw new Error(`No se puede detectar el tipo de carta del archivo: ${nombre}`);
}

function generarIdGlobal(tipo: TipoCarta) {
  const prefijos: Record<TipoCarta, string> = {
    BESTIA_NORMAL: 'bn',
    BESTIA_HABILIDAD: 'bh',
    CONJURO_NORMAL: 'c',
    CONJURO_CAMPO: 'cj',
    RECURSO: 'r',
    REINA: 'q',
    TOKEN: 't',
  };
  return prefijos[tipo] + String(idGlobalCounter++).padStart(3, '0');
}

async function cartaYaExiste(env: { DB: D1Database }, idFisico: string, nombre: string): Promise<boolean> {
  const byId = await env.DB.prepare(`SELECT id FROM cartas WHERE idFisico = ?`).bind(idFisico).first();
  if (byId) return true;

  const byName = await env.DB.prepare(`SELECT id FROM cartas WHERE LOWER(nombre) = LOWER(?)`).bind(nombre).first();
  return !!byName;
}

async function insertarCarta(env: { DB: D1Database }, tipo: TipoCarta, carta: CartaBase) {
  const campos = Object.keys(carta);
  const placeholders = campos.map(() => '?').join(', ');
  const query = `INSERT INTO cartas (${campos.join(', ')}) VALUES (${placeholders})`;
  await env.DB.prepare(query).bind(...campos.map(c => carta[c])).run();
}

function crearCartaDesdeCsv(tipo: TipoCarta, row: Record<string, string>): CartaBase | null {
  const idFisico = row['ID']?.trim() || '';
  const nombre = row['NOMBRE']?.trim() || '';
  const descripcion = row['DESCRIPCION']?.trim() || '';

  if (!idFisico || !nombre || !descripcion) return null;

  const base: CartaBase = { idFisico, nombre, descripcion, tipoCarta: tipo };

  switch (tipo) {
    case 'RECURSO':
    case 'CONJURO_NORMAL':
    case 'CONJURO_CAMPO':
      return base;

    case 'REINA':
    case 'TOKEN':
      base.atk = extraerValorDesdeCampo(row['ATK'], 'ATK');
      base.def = extraerValorDesdeCampo(row['DEF'], 'DEF');
      base.lvl = convertirNivelRomano(row['LVL']);
      base.reino = row['REINO']?.toUpperCase() || null;
      return base;

    case 'BESTIA_NORMAL':
    case 'BESTIA_HABILIDAD':
      base.atk = extraerValorDesdeCampo(row['ATK'], 'ATK');
      base.def = extraerValorDesdeCampo(row['DEF'], 'DEF');
      base.lvl = convertirNivelRomano(row['LVL']);
      base.reino = row['REINO']?.toUpperCase() || null;
      base.tieneHabilidadEsp = tipo === 'BESTIA_HABILIDAD';
      return base;

    default:
      return null;
  }
}

function extraerValorDesdeCampo(campo: string, clave: string): number {
  if (!campo || !campo.startsWith(`${clave}=`)) return 0;
  return parseInt(campo.split('=')[1]?.trim()) || 0;
}

function convertirNivelRomano(texto: string = ''): number {
  const clean = texto.toUpperCase().replace(/LVL\.?\s*/i, '').trim();
  const map: Record<string, number> = {
    I: 1, II: 2, III: 3, IV: 4, V: 5,
    VI: 6, VII: 7, VIII: 8, IX: 9, X: 10
  };
  return map[clean] ?? 0;
}
