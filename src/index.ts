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

    // Endpoint que importa JSON desde archivo para insertar en DB
    app.post('/admin/importar-json', authMiddleware, async (c) => {
      try {
        // Extraer arrays del JSON importado
        const { cartas = [], bestias = [], reinas = [], tokens = [], conjuros = [], recursos = [] } = cartasData as any;
      
        // Helper para debug si hay undefined
        const checkUndefined = (obj: any, tabla: string) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) {
              console.warn(`⚠️ En tabla ${tabla}, el campo "${k}" está undefined`);
            }
          }
        };
      
        // Mapeo de tipoCarta a tabla
        const tipoMap: Record<string, string> = {
          BESTIA: 'bestias',
          BESTIA_HABILIDAD: 'bestias',
          REINA: 'reinas',
          TOKEN: 'tokens',
          CONJURO: 'conjuros',
          RECURSO: 'recursos'
        };
      
        const errores: string[] = [];
      
        // =========================
        // 1. Insertar CARTAS
        // =========================
        const cartaValues: any[] = [];
        for (const p of cartas) {
          const cartaDb = {
            id_global: p.idGlobal,
            id_fisico: p.idFisico,
            nombre: p.nombre,
            descripcion: p.descripcion,
            tipo_carta: p.tipoCarta
          };
          checkUndefined(cartaDb, 'cartas');
          cartaValues.push(...Object.values(cartaDb));
        }
      
        if (cartaValues.length) {
          await env.DB.prepare(
            `INSERT INTO cartas (id_global, id_fisico, nombre, descripcion, tipo_carta) VALUES ${cartas.map(() => "(?, ?, ?, ?, ?)").join(", ")}`
          ).bind(...cartaValues).run();
        }
      
        // =========================
        // 2. Obtener IDs generados
        // =========================
        const allCartas = await env.DB.prepare(`SELECT id, tipo_carta, id_fisico FROM cartas`).all<{ id: number; tipo_carta: string; id_fisico: string }>();
        const idPorFisico = new Map(allCartas.results.map(c => [c.id_fisico, { id: c.id, tipo: c.tipo_carta }]));
      
        // Helper para obtener id validando tipo
        const getIdSiTipo = (obj: any, tabla: string) => {
          const found = idPorFisico.get(obj.idFisico);
          if (!found) return null;
          if (tipoMap[found.tipo] !== tabla) return null;
          return found.id;
        };
      
        // =========================
        // Función genérica de inserción masiva
        // =========================
        const insertarMasivo = async (items: any[], tabla: string, cols: string[], mapItem: (item: any, id: number) => any) => {
          const values: any[] = [];
          for (const item of items) {
            const id = getIdSiTipo(item, tabla);
            if (!id) {
              errores.push(`Item con JSON id=${item.id} en tabla ${tabla} no tiene carta asociada o tipo incorrecto`);
              continue;
            }
            const dbItem = mapItem(item, id);
            checkUndefined(dbItem, tabla);
            values.push(...Object.values(dbItem));
          }
          if (values.length) {
            await env.DB.prepare(
              `INSERT INTO ${tabla} (${cols.join(", ")}) VALUES ${items.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ")}`
            ).bind(...values).run();
          }
        };
      
        // =========================
        // 3. Insertar subtablas
        // =========================
        await insertarMasivo(bestias, 'bestias', ['id', 'atk', 'def', 'lvl', 'reino', 'tiene_habilidad_esp'],
          (b, id) => ({
            id,
            atk: b.atk,
            def: b.def,
            lvl: b.lvl,
            reino: b.reino,
            tiene_habilidad_esp: b.tieneHabilidadEsp ? 1 : 0
          })
        );
      
        await insertarMasivo(reinas, 'reinas', ['id', 'atk', 'lvl', 'reino'],
          (r, id) => ({ id, atk: r.atk, lvl: r.lvl, reino: r.reino })
        );
      
        await insertarMasivo(tokens, 'tokens', ['id', 'atk', 'def', 'lvl', 'reino'],
          (t, id) => ({ id, atk: t.atk, def: t.def, lvl: t.lvl, reino: t.reino })
        );
      
        await insertarMasivo(conjuros, 'conjuros', ['id', 'tipo'],
          (cj, id) => ({ id, tipo: cj.tipo })
        );
      
        await insertarMasivo(recursos, 'recursos', ['id'],
          (rc, id) => ({ id })
        );
      
        return c.json({ message: 'Importación finalizada', errores });
      
      } catch (err: any) {
        console.error("❌ Error en importar-json:", err);
        return c.json({ error: err.message }, 500);
      }
    });


        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
