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
        // Endpoint para importar JSON ya empaquetado
        app.post('/admin/importar-json', authMiddleware, async (c) => {
            try {
                // Extraer los arrays desde el JSON importado
                const { cartas = [], bestias = [], reinas = [], tokens = [], conjuros = [], recursos = [] } = cartasData as any;

                // Insertar cartas (padres)
                for (const p of cartas) {
                    const exists = await env.DB.prepare(`SELECT id FROM cartas WHERE id_fisico = ? LIMIT 1`).bind(p.id_fisico).first();
                    if (exists) continue;

                    const cols = ['id_global', 'id_fisico', 'nombre', 'descripcion', 'tipo_carta'];
                    const q = `INSERT INTO cartas (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
                    await env.DB.prepare(q).bind(p.id_global, p.id_fisico, p.nombre, p.descripcion, p.tipo_carta).run();
                }

                // Función para obtener el id generado de carta
                const getParentId = async (id_fisico: string) => {
                    const row = await env.DB.prepare(`SELECT id FROM cartas WHERE id_fisico = ? LIMIT 1`).bind(id_fisico).first();
                    return row?.id ?? null;
                };

                // Insertar bestias
                for (const b of bestias) {
                    const parentId = await getParentId(b.id_fisico);
                    if (!parentId) continue;
                    const exists = await env.DB.prepare(`SELECT id FROM bestia WHERE id = ? LIMIT 1`).bind(parentId).first();
                    if (exists) continue;
                    await env.DB.prepare(
                        `INSERT INTO bestia (id, atk, def, lvl, reino, tiene_habilidad_esp) VALUES (?, ?, ?, ?, ?, ?)`
                    ).bind(parentId, b.atk, b.def, b.lvl, b.reino, b.tiene_habilidad_esp ? 1 : 0).run();
                }

                // Insertar reinas
                for (const r of reinas) {
                    const parentId = await getParentId(r.id_fisico);
                    if (!parentId) continue;
                    const exists = await env.DB.prepare(`SELECT id FROM reina WHERE id = ? LIMIT 1`).bind(parentId).first();
                    if (exists) continue;
                    await env.DB.prepare(`INSERT INTO reina (id, atk, lvl, reino) VALUES (?, ?, ?, ?)`)
                        .bind(parentId, r.atk, r.lvl, r.reino).run();
                }

                // Insertar tokens
                for (const t of tokens) {
                    const parentId = await getParentId(t.id_fisico);
                    if (!parentId) continue;
                    const exists = await env.DB.prepare(`SELECT id FROM token WHERE id = ? LIMIT 1`).bind(parentId).first();
                    if (exists) continue;
                    await env.DB.prepare(`INSERT INTO token (id, atk, def, lvl, reino) VALUES (?, ?, ?, ?, ?)`)
                        .bind(parentId, t.atk, t.def, t.lvl, t.reino).run();
                }

                // Insertar conjuros
                for (const cj of conjuros) {
                    const parentId = await getParentId(cj.id_fisico);
                    if (!parentId) continue;
                    const exists = await env.DB.prepare(`SELECT id FROM conjuro WHERE id = ? LIMIT 1`).bind(parentId).first();
                    if (exists) continue;
                    await env.DB.prepare(`INSERT INTO conjuro (id, tipo) VALUES (?, ?)`).bind(parentId, cj.tipo).run();
                }

                // Insertar recursos
                for (const rc of recursos) {
                    const parentId = await getParentId(rc.id_fisico);
                    if (!parentId) continue;
                    const exists = await env.DB.prepare(`SELECT id FROM recurso WHERE id = ? LIMIT 1`).bind(parentId).first();
                    if (exists) continue;
                    await env.DB.prepare(`INSERT INTO recurso (id) VALUES (?)`).bind(parentId).run();
                }

                return c.json({ message: 'Importación finalizada' });
            } catch (err: any) {
                return c.json({ error: err.message }, 500);
            }
        });

        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
