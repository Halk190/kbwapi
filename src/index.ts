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
    ADMIN_TOKEN: SecretsStoreSecret;
    USER_TOKEN: SecretsStoreSecret;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();

    // CORS para todas las rutas
    app.use('*', async (c, next) => cors()(c, next));

    // Obtener secreto para auth
    const adminSecret = await env.ADMIN_TOKEN.get();
    const userSecret = await env.USER_TOKEN.get();

    // Admin (token fijo)
    const adminMiddleware = async (c: Context, next: Next) => {
      const authHeader = c.req.header('Authorization');
      if (!authHeader) return c.json({ error: 'Unauthorized' }, 401);
    
      const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
      if (token !== adminSecret) return c.json({ error: 'Unauthorized' }, 401);
    
      return next();
    };

    // Middleware para autenticar vía Bearer token
    const userMiddleware = async (c: Context, next: Next) => {
      const authHeader = c.req.header('Authorization');
      if (!authHeader) return c.json({ error: 'Unauthorized' }, 401);

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : authHeader;

      if (token !== userSecret) return c.json({ error: 'Unauthorized' }, 401);

      return next();
    };

    // Endpoints REST CRUD
    app.all('/rest/*', userMiddleware, handleRest);

    // Endpoint para ejecutar consultas SQL arbitrarias
    app.post('/query', userMiddleware, async (c) => {
      try {
        const { query, params } = await c.req.json();
        if (!query) return c.json({ error: 'Query is required' }, 400);

        const results = await env.DB.prepare(query).bind(...(params || [])).all();
        return c.json(results);
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    });
    
    const CHUNK_SIZE = 15; // tamaño de lotes para evitar saturar SQLite

    // Tipos para tus datos
    type Carta = {
      id: number;
      idGlobal?: string;
      idFisico?: string;
      nombre: string;
      descripcion: string;
      tipoCarta: string;
    };
    
    type Bestia = {
      id: number;
      atk: number;
      def: number;
      lvl: number;
      reino: string;
      tieneHabilidadEsp: number;
    };
    
    type Reina = {
      id: number;
      atk: number;
      lvl: number;
      reino: string;
    };
    
    type Token = {
      id: number;
      atk: number;
      def: number;
      lvl: number;
      reino: string;
    };
    
    type Conjuro = {
      id: number;
      tipo: string;
    };
    
    type Recurso = {
      id: number;
    };
      
    // Endpoint que importa JSON desde archivo para insertar en DB
    app.post('/admin/importar-json', adminMiddleware, async (c: any) => {
      try {
        const { cartas = [], bestias = [], reinas = [], tokens = [], conjuros = [], recursos = [] } = cartasData as {
          cartas: Carta[];
          bestias: Bestia[];
          reinas: Reina[];
          tokens: Token[];
          conjuros: Conjuro[];
          recursos: Recurso[];
        };
      
        // Helper para debug si hay undefined
        const checkUndefined = (obj: Record<string, any>, tabla: string) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) console.error(`⚠️ En tabla ${tabla}, el campo "${k}" está undefined`);
          }
        };
      
        // Ordenar todas las listas por id ascendente
        cartas.sort((a, b) => a.id - b.id);
        bestias.sort((a, b) => a.id - b.id);
        reinas.sort((a, b) => a.id - b.id);
        tokens.sort((a, b) => a.id - b.id);
        conjuros.sort((a, b) => a.id - b.id);
        recursos.sort((a, b) => a.id - b.id);
      
        const insertChunked = async (table: string, values: any[][], columns: string[]) => {
          for (let i = 0; i < values.length; i += CHUNK_SIZE) {
            const chunk = values.slice(i, i + CHUNK_SIZE);
            const bindValues: (string | number | null)[] = [];
            for (const row of chunk) bindValues.push(...row);
            const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
            await env.DB.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`)
              .bind(...bindValues)
              .run();
          }
        };
      
        // Procesar por chunks y subtablas relacionadas
        for (let i = 0; i < cartas.length; i += CHUNK_SIZE) {
          const cartasChunk = cartas.slice(i, i + CHUNK_SIZE);
        
          // CARTAS
          const cartaValues = cartasChunk.map((p: Carta) => {
            const obj = {
              id: p.id,
              id_global: p.idGlobal,
              id_fisico: p.idFisico,
              nombre: p.nombre,
              descripcion: p.descripcion,
              tipo_carta: p.tipoCarta,
            };
            checkUndefined(obj, 'cartas');
            return Object.values(obj);
          });
          if (cartaValues.length) await insertChunked('cartas', cartaValues, ['id', 'id_global', 'id_fisico', 'nombre', 'descripcion', 'tipo_carta']);
        
          // BESTIAS
          const bestiaValues = bestias.filter(b => cartasChunk.some(c => c.id === b.id))
            .map((b: Bestia) => {
              const obj = {
                id: b.id,
                atk: b.atk,
                def: b.def,
                lvl: b.lvl,
                reino: b.reino,
                tiene_habilidad_esp: b.tieneHabilidadEsp ? 1 : 0,
              };
              checkUndefined(obj, 'bestias');
              return Object.values(obj);
            });
          if (bestiaValues.length) await insertChunked('bestias', bestiaValues, ['id', 'atk', 'def', 'lvl', 'reino', 'tiene_habilidad_esp']);
          
          // REINAS
          const reinasValues = reinas.filter(r => cartasChunk.some(c => c.id === r.id))
            .map((r: Reina) => {
              const obj = { id: r.id, atk: r.atk, lvl: r.lvl, reino: r.reino };
              checkUndefined(obj, 'reinas');
              return Object.values(obj);
            });
          if (reinasValues.length) await insertChunked('reinas', reinasValues, ['id', 'atk', 'lvl', 'reino']);
          
          // TOKENS
          const tokenValues = tokens.filter(t => cartasChunk.some(c => c.id === t.id))
            .map((t: Token) => {
              const obj = { id: t.id, atk: t.atk, def: t.def, lvl: t.lvl, reino: t.reino };
              checkUndefined(obj, 'tokens');
              return Object.values(obj);
            });
          if (tokenValues.length) await insertChunked('tokens', tokenValues, ['id', 'atk', 'def', 'lvl', 'reino']);
          
          // CONJUROS
          const conjuroValues = conjuros.filter(cj => cartasChunk.some(c => c.id === cj.id))
            .map((cj: Conjuro) => {
              const obj = { id: cj.id, tipo: cj.tipo };
              checkUndefined(obj, 'conjuros');
              return Object.values(obj);
            });
          if (conjuroValues.length) await insertChunked('conjuros', conjuroValues, ['id', 'tipo']);
          
          // RECURSOS
          const recursoValues = recursos.filter(rc => cartasChunk.some(c => c.id === rc.id))
            .map((rc: Recurso) => {
              const obj = { id: rc.id };
              checkUndefined(obj, 'recursos');
              return Object.values(obj);
            });
          if (recursoValues.length) await insertChunked('recursos', recursoValues, ['id']);
        }
      
        return c.json({ message: 'Importación finalizada' });
      } catch (err: any) {
        console.error("❌ Error en importar-json:", err);
        return c.json({ error: err.message }, 500);
      }
    });

    // Endpoint para obtener todas las cartas
    app.get('/allcards', userMiddleware, async (c: any) => {
      try {
        // Obtener todas las cartas
        const cartasRows = await env.DB.prepare(`SELECT id, id_fisico, nombre, descripcion, tipo_carta FROM cartas ORDER BY id ASC`).all();
        const cartas = cartasRows.results as { 
          id: number;
          id_fisico: string;
          nombre: string;
          descripcion: string;
          tipo_carta: string;
        }[];
      
        const fetchSubtable = async (table: string, columns: string[], ids: number[]): Promise<Record<number, any>> => {
          const combined: Record<number, any> = {};
          const CHUNK_SIZE = 15; // evitar too many SQL variables
          for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
          
            // Armar lista de columnas dinámicamente
            const cols = columns.length > 0 ? `, ${columns.join(',')}` : '';
            const query = `SELECT id${cols} FROM ${table} WHERE id IN (${placeholders})`;
          
            const rows = await env.DB.prepare(query).bind(...chunk).all();
            for (const row of rows.results as any[]) {
              const rowTyped = row as { id: number; [key: string]: any };
              combined[rowTyped.id] = rowTyped;
            }
          }
          return combined;
        };
      
        const ids = cartas.map(c => c.id as number);
      
        // Cargar subtablas
        const bestiasMap = await fetchSubtable('bestias', ['atk','def','lvl','reino','tiene_habilidad_esp'], ids);
        const reinasMap = await fetchSubtable('reinas', ['atk','lvl','reino'], ids);
        const tokensMap = await fetchSubtable('tokens', ['atk','def','lvl','reino'], ids);
        const conjurosMap = await fetchSubtable('conjuros', ['tipo'], ids);
        const recursosMap = await fetchSubtable('recursos', [], ids);
      
        // Combinar resultados
        const result = cartas.map(ca => {
          const obj: any = {
            idFisico: ca.id_fisico,
            nombre: ca.nombre,
            descripcion: ca.descripcion,
            tipoCarta: ca.tipo_carta
          };
        
          if (bestiasMap[ca.id]) {
            const b = bestiasMap[ca.id];
            obj.atk = b.atk; obj.def = b.def; obj.lvl = b.lvl; obj.reino = b.reino; obj.tieneHabilidadEsp = b.tiene_habilidad_esp;
          } else if (reinasMap[ca.id]) {
            const r = reinasMap[ca.id];
            obj.atk = r.atk; obj.lvl = r.lvl; obj.reino = r.reino;
          } else if (tokensMap[ca.id]) {
            const t = tokensMap[ca.id];
            obj.atk = t.atk; obj.def = t.def; obj.lvl = t.lvl; obj.reino = t.reino;
          } else if (conjurosMap[ca.id]) {
            const cj = conjurosMap[ca.id];
            obj.tipo = cj.tipo;
          }
        
          return obj;
        });
      
        return c.json(result);
      
      } catch (err: any) {
        console.error(err);
        return c.json({ error: err.message }, 500);
      }
    });

    // Endpoint para filtrar cartas por tipo y reino
    app.get("/filter-cards", userMiddleware, async (c) => {
      try {
        // Recibir query params tipo y reino
        const tiposParam = (c.req.query("tipo") as string | undefined)?.toUpperCase();
        const reinoParam = (c.req.query("reino") as string | undefined)?.toUpperCase();
      
        // Validar reino si existe
        const validReinos = ["NATURA", "NICROM", "PYRO", "AQUA"];
        if (reinoParam && !validReinos.includes(reinoParam)) {
          return c.json({ error: `Reino inválido. Los válidos son: ${validReinos.join(", ")}` }, 400);
        }
      
        // Mapear tipos de usuario a tablas y columnas
        const tipoMap: Record<string, { table: string; columns: string[] }> = {
          BESTIA_NORMAL: { table: "bestias", columns: ["atk", "def", "lvl", "reino", "tiene_habilidad_esp"] },
          BESTIA_HABILIDAD: { table: "bestias", columns: ["atk", "def", "lvl", "reino", "tiene_habilidad_esp"] },
          REINA: { table: "reinas", columns: ["atk", "lvl", "reino"] },
          TOKEN: { table: "tokens", columns: ["atk", "def", "lvl", "reino"] },
          CONJURO_NORMAL: { table: "conjuros", columns: ["tipo"] },
          CONJURO_CAMPO: { table: "conjuros", columns: ["tipo"] },
          RECURSO: { table: "recursos", columns: [] }
        };
      
        const tipos = tiposParam ? tiposParam.split(",") : [];
        for (const t of tipos) {
          if (!tipoMap[t]) return c.json({ error: `Tipo inválido: ${t}` }, 400);
        }
      
        // Obtener todas las cartas
        const cartasRows = await env.DB.prepare(`SELECT id, id_fisico AS idFisico, nombre, descripcion, tipo_carta AS tipoCarta FROM cartas ORDER BY id ASC`).all();
        const cartas = cartasRows.results as { id: number; idFisico?: string; nombre: string; descripcion: string; tipoCarta: string }[];
        const ids = cartas.map(ca => ca.id);
      
        const CHUNK_SIZE = 15;
      
        // Helper para cargar subtablas con filtro por reino
        const fetchSubtable = async (table: string, columns: string[]): Promise<Record<number, any>> => {
          const combined: Record<number, any> = {};
          for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const cols = columns.length > 0 ? `, ${columns.join(",")}` : "";
            let query = `SELECT id${cols} FROM ${table} WHERE id IN (${placeholders})`;
            const bind: (string | number)[] = [...chunk];
          
            // Aplicar filtro de reino solo si la tabla tiene columna "reino"
            if (reinoParam && ["bestias", "reinas", "tokens"].includes(table)) {
              query += " AND reino = ?";
              bind.push(reinoParam);
            }
          
            const rows = await env.DB.prepare(query).bind(...bind).all();
            for (const row of rows.results as any[]) combined[row.id] = row;
          }
          return combined;
        };
      
        // Obtener subtablas solo de los tipos seleccionados
        const tablasUsadas = Array.from(new Set(tipos.map(t => tipoMap[t].table)));
        const bestiasMap = tablasUsadas.includes("bestias") ? await fetchSubtable("bestias", ["atk","def","lvl","reino","tiene_habilidad_esp"]) : {};
        const reinasMap = tablasUsadas.includes("reinas") ? await fetchSubtable("reinas", ["atk","lvl","reino"]) : {};
        const tokensMap = tablasUsadas.includes("tokens") ? await fetchSubtable("tokens", ["atk","def","lvl","reino"]) : {};
        const conjurosMap = tablasUsadas.includes("conjuros") ? await fetchSubtable("conjuros", ["tipo"]) : {};
        const recursosMap = tablasUsadas.includes("recursos") ? await fetchSubtable("recursos", []) : {};
      
        // Combinar resultados con filtros dinámicos
        const result = cartas
          .filter(ca => {
            let include = false;
            for (const t of tipos) {
              const { table } = tipoMap[t];
              if (
                (table === "bestias" && bestiasMap[ca.id]) ||
                (table === "reinas" && reinasMap[ca.id]) ||
                (table === "tokens" && tokensMap[ca.id]) ||
                (table === "conjuros" && conjurosMap[ca.id]) ||
                (table === "recursos" && recursosMap[ca.id])
              ) {
                include = true;
              }
            }
            return include;
          })
          .map(ca => {
            const obj: any = {
              idFisico: ca.idFisico,
              nombre: ca.nombre,
              descripcion: ca.descripcion,
              tipoCarta: ca.tipoCarta
            };
            if (bestiasMap[ca.id]) {
              const b = bestiasMap[ca.id];
              obj.atk = b.atk; obj.def = b.def; obj.lvl = b.lvl; obj.reino = b.reino; obj.tieneHabilidadEsp = b.tiene_habilidad_esp;
            } else if (reinasMap[ca.id]) {
              const r = reinasMap[ca.id];
              obj.atk = r.atk; obj.lvl = r.lvl; obj.reino = r.reino;
            } else if (tokensMap[ca.id]) {
              const t = tokensMap[ca.id];
              obj.atk = t.atk; obj.def = t.def; obj.lvl = t.lvl; obj.reino = t.reino;
            } else if (conjurosMap[ca.id]) {
              const cj = conjurosMap[ca.id];
              obj.tipo = cj.tipo;
            }
            return obj;
          });
        
        return c.json(result);
        
      } catch (err: any) {
        console.error(err);
        return c.json({ error: err.message }, 500);
      }
    });

        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
