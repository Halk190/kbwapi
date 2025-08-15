import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from './rest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cartasData from './resources/dataset/cartas.json';

// Importa directamente el JSON (removido por incompatibilidad con import assertions)
// import cartasData from './resources/dataset/cartas.json' assert { type: 'json' };

export interface Env {
    DB: D1Database;
    SECRET: SecretsStoreSecret;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();

    // CORS para todas las rutas
    app.use('*', async (c, next) => cors()(c, next));

    // Obtener secreto para auth
    const secret = await env.SECRET.get();

    // Middleware para autenticar vía Bearer token
    const authMiddleware = async (c: Context, next: Next) => {
      const authHeader = c.req.header('Authorization');
      if (!authHeader) return c.json({ error: 'Unauthorized' }, 401);

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : authHeader;

      if (token !== secret) return c.json({ error: 'Unauthorized' }, 401);

      return next();
    };

    // Endpoints REST CRUD
    app.all('/rest/*', authMiddleware, handleRest);

    // Endpoint para ejecutar consultas SQL arbitrarias
    app.post('/query', authMiddleware, async (c) => {
      try {
        const { query, params } = await c.req.json();
        if (!query) return c.json({ error: 'Query is required' }, 400);

        const results = await env.DB.prepare(query).bind(...(params || [])).all();
        return c.json(results);
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    });

    const CHUNK_SIZE = 50; // tamaño de lotes para evitar saturar SQLite

    // Endpoint que importa JSON desde archivo para insertar en DB
    app.post('/admin/importar-json', authMiddleware, async (c: any) => {
      try {
        // Extraer arrays del JSON importado
        const { cartas = [], bestias = [], reinas = [], tokens = [], conjuros = [], recursos = [] } = cartasData as any;
      
        // Helper para debug si hay undefined
        const checkUndefined = (obj: any, tabla: string) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) {
              console.error(`⚠️ En tabla ${tabla}, el campo "${k}" está undefined`);
            }
          }
        };
      
        // Función para insertar por chunks asegurando que no haya promesas
        const insertChunked = async (table: string, values: any[][], columns: string[]) => {
          for (let i = 0; i < values.length; i += CHUNK_SIZE) {
            const chunk = values.slice(i, i + CHUNK_SIZE);
          
            // Aplanar y convertir todo a string/number por si acaso
            const bindValues: (string | number | null)[] = [];
            for (const row of chunk) {
              for (const val of row) {
                if (val instanceof Promise) {
                  throw new Error('Se detectó un Promise dentro de los valores a insertar');
                }
                bindValues.push(val);
              }
            }
          
            const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
            await env.DB.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`)
              .bind(...bindValues)
              .run();
          }
        };
      
        // =========================
        // 1. Insertar CARTAS
        // =========================
        if (cartas.length) {
          const cartaValues = cartas.map(async (p:any) => {
            const obj = {
              id: p.id,
              id_global: p.idGlobal,
              id_fisico: p.idFisico,
              nombre: p.nombre,
              descripcion: p.descripcion,
              tipo_carta: p.tipoCarta
            };
            checkUndefined(obj, 'cartas');
            return Object.values(obj);
          });
          await insertChunked('cartas', cartaValues, ['id', 'id_global', 'id_fisico', 'nombre', 'descripcion', 'tipo_carta']);
        }
      
        // =========================
        // 2. Insertar BESTIAS
        // =========================
        if (bestias.length) {
          const bestiaValues = bestias.map(async (b:any) => {
            const obj = {
              id: b.id,
              atk: b.atk,
              def: b.def,
              lvl: b.lvl,
              reino: b.reino,
              tiene_habilidad_esp: b.tieneHabilidadEsp ? 1 : 0
            };
            checkUndefined(obj, 'bestias');
            return Object.values(obj);
          });
          await insertChunked('bestias', bestiaValues, ['id', 'atk', 'def', 'lvl', 'reino', 'tiene_habilidad_esp']);
        }
      
        // =========================
        // 3. Insertar REINAS
        // =========================
        if (reinas.length) {
          const reinasValues = reinas.map(async (r:any) => {
            const obj = { id: r.id, atk: r.atk, lvl: r.lvl, reino: r.reino };
            checkUndefined(obj, 'reinas');
            return Object.values(obj);
          });
          await insertChunked('reinas', reinasValues, ['id', 'atk', 'lvl', 'reino']);
        }
      
        // =========================
        // 4. Insertar TOKENS
        // =========================
        if (tokens.length) {
          const tokenValues = tokens.map(async (t:any) => {
            const obj = { id: t.id, atk: t.atk, def: t.def, lvl: t.lvl, reino: t.reino };
            checkUndefined(obj, 'tokens');
            return Object.values(obj);
          });
          await insertChunked('tokens', tokenValues, ['id', 'atk', 'def', 'lvl', 'reino']);
        }
      
        // =========================
        // 5. Insertar CONJUROS
        // =========================
        if (conjuros.length) {
          const conjuroValues = conjuros.map(async (cj:any) => {
            const obj = { id: cj.id, tipo: cj.tipo };
            checkUndefined(obj, 'conjuros');
            return Object.values(obj);
          });
          await insertChunked('conjuros', conjuroValues, ['id', 'tipo']);
        }
      
        // =========================
        // 6. Insertar RECURSOS
        // =========================
        if (recursos.length) {
          const recursoValues = recursos.map(async (rc:any) => {
            const obj = { id: rc.id };
            checkUndefined(obj, 'recursos');
            return Object.values(obj);
          });
          await insertChunked('recursos', recursoValues, ['id']);
        }
      
        return c.json({ message: 'Importación finalizada' });
      
      } catch (err: any) {
        console.error("❌ Error en importar-json:", err);
        return c.json({ error: err.message }, 500);
      }
    });



        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
