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
                      console.error(`⚠️ En tabla ${tabla}, el campo "${k}" está undefined`);
                  }
              }
          };

          // 📌 Cartas
          for (const p of cartas) {
              const exists = await env.DB.prepare(
                  `SELECT id FROM cartas WHERE id_fisico = ? LIMIT 1`
              ).bind(p.idFisico).first();
              if (exists) continue;

              const cartaDb = {
                  id_global: p.idGlobal,
                  id_fisico: p.idFisico,
                  nombre: p.nombre,
                  descripcion: p.descripcion,
                  tipo_carta: p.tipoCarta
              };
              checkUndefined(cartaDb, 'cartas');

              const cols = Object.keys(cartaDb);
              const q = `INSERT INTO cartas (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
              console.log("Insertando carta:", cartaDb);

              await env.DB.prepare(q).bind(...Object.values(cartaDb)).run();
          }

          // Función para obtener id generado de carta
          const getParentId = async (item: any) => {
            if (item.idFisico) {
              const row = await env.DB.prepare(`SELECT id FROM cartas WHERE id_fisico = ? LIMIT 1`)
                .bind(item.idFisico).first();
              return row?.id ?? null;
            }
            if (item.id) {
              return item.id; // ya es el ID padre
            }
            return null;
          };

          // 📌 Bestias
          for (const b of bestias) {
              const parentId = await getParentId(b);
              if (!parentId) continue;

              const exists = await env.DB.prepare(`SELECT id FROM bestia WHERE id = ? LIMIT 1`).bind(parentId).first();
              if (exists) continue;

              const bestiaDb = {
                  id: parentId,
                  atk: b.atk,
                  def: b.def,
                  lvl: b.lvl,
                  reino: b.reino,
                  tiene_habilidad_esp: b.tieneHabilidadEsp ? 1 : 0
              };
              checkUndefined(bestiaDb, 'bestia');

              await env.DB.prepare(
                  `INSERT INTO bestia (id, atk, def, lvl, reino, tiene_habilidad_esp) VALUES (?, ?, ?, ?, ?, ?)`
              ).bind(...Object.values(bestiaDb)).run();
          }

          // 📌 Reinas
          for (const r of reinas) {
              const parentId = await getParentId(r);
              if (!parentId) continue;

              const exists = await env.DB.prepare(`SELECT id FROM reina WHERE id = ? LIMIT 1`).bind(parentId).first();
              if (exists) continue;

              const reinaDb = {
                  id: parentId,
                  atk: r.atk,
                  lvl: r.lvl,
                  reino: r.reino
              };
              checkUndefined(reinaDb, 'reina');

              await env.DB.prepare(
                  `INSERT INTO reina (id, atk, lvl, reino) VALUES (?, ?, ?, ?)`
              ).bind(...Object.values(reinaDb)).run();
          }

          // 📌 Tokens
          for (const t of tokens) {
              const parentId = await getParentId(t);
              if (!parentId) continue;

              const exists = await env.DB.prepare(`SELECT id FROM token WHERE id = ? LIMIT 1`).bind(parentId).first();
              if (exists) continue;

              const tokenDb = {
                  id: parentId,
                  atk: t.atk,
                  def: t.def,
                  lvl: t.lvl,
                  reino: t.reino
              };
              checkUndefined(tokenDb, 'token');

              await env.DB.prepare(
                  `INSERT INTO token (id, atk, def, lvl, reino) VALUES (?, ?, ?, ?, ?)`
              ).bind(...Object.values(tokenDb)).run();
          }

          // 📌 Conjuros
          for (const cj of conjuros) {
              const parentId = await getParentId(cj);
              if (!parentId) continue;

              const exists = await env.DB.prepare(`SELECT id FROM conjuro WHERE id = ? LIMIT 1`).bind(parentId).first();
              if (exists) continue;

              const conjuroDb = {
                  id: parentId,
                  tipo: cj.tipo
              };
              checkUndefined(conjuroDb, 'conjuro');

              await env.DB.prepare(
                  `INSERT INTO conjuro (id, tipo) VALUES (?, ?)`
              ).bind(...Object.values(conjuroDb)).run();
          }

          // 📌 Recursos
          for (const rc of recursos) {
              const parentId = await getParentId(rc);
              if (!parentId) continue;

              const exists = await env.DB.prepare(`SELECT id FROM recurso WHERE id = ? LIMIT 1`).bind(parentId).first();
              if (exists) continue;

              const recursoDb = { id: parentId };
              checkUndefined(recursoDb, 'recurso');

              await env.DB.prepare(
                  `INSERT INTO recurso (id) VALUES (?)`
              ).bind(...Object.values(recursoDb)).run();
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
