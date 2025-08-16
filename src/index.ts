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
        // ============================
        // 1) Leer y normalizar parámetros
        // ============================
        const rawTipo = c.req.query("tipo") ?? undefined;
        const rawReino = c.req.query("reino") ?? undefined;
        const rawNivel = c.req.query("nivel") ?? undefined;

        // Normalizar lista de tipos (ej: "bestia normal, reina" → ["BESTIA_NORMAL","REINA"])
        const tipos: string[] = rawTipo
          ? Array.from(new Set(
              rawTipo.split(",")
                .map(s => s.trim())
                .filter(Boolean)
                .map(s => s.toUpperCase().replace(/\s+/g, "_"))
            ))
          : [];
          
        // Normalizar lista de reinos (ej: "natura, pyro" → ["NATURA","PYRO"])
        const reinos: string[] = rawReino
          ? Array.from(new Set(
              rawReino.split(",")
                .map(s => s.trim())
                .filter(Boolean)
                .map(s => s.toUpperCase())
            ))
          : [];
          
        // Nivel (con validación para que solo acepte 1–7)
        const nivel: number | undefined = rawNivel ? parseInt(rawNivel, 10) : undefined;
        if (nivel && (nivel < 1 || nivel > 7)) {
          return c.json({ error: "El nivel debe estar entre 1 y 7." }, 400);
        }

        // ============================
        // 2) Validar inputs
        // ============================
        const validReinos = ["NATURA", "NICROM", "PYRO", "AQUA"];
        for (const r of reinos) {
          if (!validReinos.includes(r)) {
            return c.json({ error: `Reino inválido: ${r}. Válidos: ${validReinos.join(", ")}` }, 400);
          }
        }
      
        const tipoMap: Record<string, { table: "bestias"|"reinas"|"tokens"|"cartas" }> = {
          BESTIA_NORMAL:   { table: "bestias" },
          BESTIA_HABILIDAD:{ table: "bestias" },
          REINA:           { table: "reinas" },
          TOKEN:           { table: "tokens" },
          CONJURO_NORMAL:  { table: "cartas" },
          CONJURO_CAMPO:   { table: "cartas" },
          RECURSO:         { table: "cartas" },
        };
        for (const t of tipos) {
          if (!tipoMap[t]) {
            return c.json({ error: `Tipo inválido: ${t}` }, 400);
          }
        }
      
        if (tipos.length === 0 && reinos.length === 0 && !nivel) {
          return c.json({ error: "Debes proporcionar al menos 'tipo', 'reino' o 'nivel'." }, 400);
        }

        // ============================
        // 3) Caso especial: filtro por nivel
        // ============================
        if (nivel) {
          const subtables = [
            { name: "bestias", cols: ["atk","def","lvl","reino","tiene_habilidad_esp"] },
            { name: "reinas", cols: ["atk","lvl","reino"] },
            { name: "tokens", cols: ["atk","def","lvl","reino"] },
          ];
        
          // Guardar los registros encontrados en subtablas por ID
          const collected: Record<number, any> = {};
        
          for (const sub of subtables) {
            let query = `SELECT id, ${sub.cols.join(",")} FROM ${sub.name} WHERE lvl = ?`;
            const bind: (string|number)[] = [nivel];
          
            if (reinos.length > 0) {
              query += ` AND reino IN (${reinos.map(() => "?").join(",")})`;
              bind.push(...reinos);
            }
          
            const rows = await env.DB.prepare(query).bind(...bind).all();
            for (const row of rows.results as any[]) {
              collected[row.id] = { ...row, __table: sub.name };
            }
          }
        
          if (Object.keys(collected).length === 0) {
            return c.json([]); // no se encontró nada con ese nivel
          }
        
          // Traer cartas base solo de esos IDs
          const ids = Object.keys(collected).map(Number);
          const placeholders = ids.map(() => "?").join(",");
          const cartasRows = await env.DB.prepare(
            `SELECT id, id_fisico AS idFisico, nombre, descripcion, tipo_carta AS tipoCarta
            FROM cartas
            WHERE id IN (${placeholders})`
          ).bind(...ids).all();
        
          const cartas = cartasRows.results as any[];
        
          // Aplicar filtro de tipos si corresponde
          const filtered = cartas.filter(ca =>
            tipos.length === 0 ? true : tipos.includes(ca.tipoCarta)
          );
        
          // Combinar datos de carta + stats de subtablas
          const result = filtered.map(ca => {
            const extra = collected[ca.id];
            return {
              idFisico: ca.idFisico,
              nombre: ca.nombre,
              descripcion: ca.descripcion,
              tipoCarta: ca.tipoCarta,
              ...(extra ? {
                atk: extra.atk,
                def: extra.def,
                lvl: extra.lvl,
                reino: extra.reino,
                ...(extra.hasOwnProperty("tiene_habilidad_esp") ? { tieneHabilidadEsp: extra.tiene_habilidad_esp === 1 } : {})
              } : {})
            };
          });
        
          return c.json(result);
        }
      
        // ============================
        // 4) Caso general (tipo / reino)
        // ============================
        const cartasRows = await env.DB.prepare(
          `SELECT id, id_fisico AS idFisico, nombre, descripcion, tipo_carta AS tipoCarta
          FROM cartas
          ORDER BY id ASC`
        ).all();

        const cartas = cartasRows.results as {
          id: number; idFisico?: string; nombre: string; descripcion: string; tipoCarta: string
        }[];
        const ids = cartas.map(c => c.id);

        const CHUNK_SIZE = 15;

        // Helper: filtrar reinos válidos por tabla
        const reinosParaTabla = (table: string): string[]|undefined => {
          if (reinos.length === 0) return undefined;
          if (table === "bestias" || table === "reinas") return reinos;
          if (table === "tokens") {
            return reinos.includes("NATURA") ? ["NATURA"] : [];
          }
          return undefined;
        };

        // Definición de subtables con sus columnas
        const subtables = [
          { name: "bestias", cols: ["atk","def","lvl","reino","tiene_habilidad_esp"] },
          { name: "reinas", cols: ["atk","lvl","reino"] },
          { name: "tokens", cols: ["atk","def","lvl","reino"] },
        ];

        // Fetch genérico para cada subtabla
        const fetchSubtable = async (
          table: string,
          columns: string[],
          ids: number[],
          reinosFiltro?: string[]
        ): Promise<Record<number, any>> => {
          const combined: Record<number, any> = {};
          if (reinosFiltro && reinosFiltro.length === 0) return combined;
        
          for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const idPlaceholders = chunk.map(() => "?").join(",");
            const cols = columns.length ? `, ${columns.join(",")}` : "";
          
            let query = `SELECT id${cols} FROM ${table} WHERE id IN (${idPlaceholders})`;
            const bind: (number|string)[] = [...chunk];
          
            if (reinosFiltro) {
              const reinoPlaceholders = reinosFiltro.map(() => "?").join(",");
              query += ` AND reino IN (${reinoPlaceholders})`;
              bind.push(...reinosFiltro);
            }
          
            const rows = await env.DB.prepare(query).bind(...bind).all();
            for (const row of rows.results as any[]) {
              combined[row.id] = { ...row, __table: table }; // agrego __table para identificar origen
            }
          }
          return combined;
        };

        // Determinar qué tablas consultar
        const tablasPorTipos = new Set(tipos.map(t => tipoMap[t].table));
        if (reinos.length > 0) {
          tablasPorTipos.add("bestias");
          tablasPorTipos.add("reinas");
          if (reinos.includes("NATURA")) tablasPorTipos.add("tokens");
        }

        // Ejecutar consultas y consolidar resultados en un solo mapa
        const collected: Record<number, any> = {};
        for (const sub of subtables) {
          if (tablasPorTipos.has(sub.name as any)) {
            const rows = await fetchSubtable(sub.name, sub.cols, ids, reinosParaTabla(sub.name));
            Object.assign(collected, rows);
          }
        }

        // ============================
        // Filtrado
        // ============================
        const matchByTipos = (carta: typeof cartas[number]): boolean => {
          if (tipos.length === 0) return false;
          return tipos.some(t => {
            if (carta.tipoCarta !== t) return false;
            const { table } = tipoMap[t];
            if (table === "cartas") return true;
            return !!collected[carta.id]; // basta con que esté en collected
          });
        };

        const matchByReinos = (id: number): boolean => {
          if (reinos.length === 0) return false;
          return !!collected[id];
        };

        const filtered = cartas.filter(ca => {
          if (tipos.length > 0 && reinos.length > 0) {
            return matchByTipos(ca) || matchByReinos(ca.id);
          }
          if (tipos.length > 0) return matchByTipos(ca);
          if (reinos.length > 0) return matchByReinos(ca.id);
          return false;
        });

        // ============================
        // Construir respuesta
        // ============================
        const result = filtered.map(ca => {
          const obj: any = {
            idFisico: ca.idFisico,
            nombre: ca.nombre,
            descripcion: ca.descripcion,
            tipoCarta: ca.tipoCarta,
          };
          const extra = collected[ca.id];
          if (extra) {
            Object.assign(obj, {
              atk: extra.atk,
              def: extra.def,
              lvl: extra.lvl,
              reino: extra.reino,
            });
            if (extra.hasOwnProperty("tiene_habilidad_esp")) {
              obj.tieneHabilidadEsp = extra.tiene_habilidad_esp === 1;
            }
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
