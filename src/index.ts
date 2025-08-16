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
        // 1) Leer y normalizar parámetros
        const rawTipo = c.req.query("tipo") ?? undefined;   // ej: "conjuro normal, bestia_habilidad"
        const rawReino = c.req.query("reino") ?? undefined; // ej: "natura,pyro"
      
        // Normaliza: a MAYÚSCULAS y espacios -> "_"
        const tipos: string[] = rawTipo
          ? Array.from(
              new Set(
                rawTipo
                  .split(",")
                  .map(s => s.trim())
                  .filter(Boolean)
                  .map(s => s.toUpperCase().replace(/\s+/g, "_"))
              )
            )
          : [];
          
        const reinos: string[] = rawReino
          ? Array.from(
              new Set(
                rawReino
                  .split(",")
                  .map(s => s.trim())
                  .filter(Boolean)
                  .map(s => s.toUpperCase())
              )
            )
          : [];
          
        // Validar reinos
        const validReinos = ["NATURA", "NICROM", "PYRO", "AQUA"];
        for (const r of reinos) {
          if (!validReinos.includes(r)) {
            return c.json({ error: `Reino inválido: ${r}. Válidos: ${validReinos.join(", ")}` }, 400);
          }
        }
      
        // Map de tipos
        const tipoMap: Record<string, { table: "bestias"|"reinas"|"tokens"|"conjuros"|"recursos"; columns: string[] }> = {
          BESTIA_NORMAL:   { table: "bestias",  columns: ["atk","def","lvl","reino","tiene_habilidad_esp"] },
          BESTIA_HABILIDAD:{ table: "bestias",  columns: ["atk","def","lvl","reino","tiene_habilidad_esp"] },
          REINA:           { table: "reinas",   columns: ["atk","lvl","reino"] },
          TOKEN:           { table: "tokens",   columns: ["atk","def","lvl","reino"] },
          CONJURO_NORMAL:  { table: "conjuros", columns: ["tipo"] },
          CONJURO_CAMPO:   { table: "conjuros", columns: ["tipo"] },
          RECURSO:         { table: "recursos", columns: [] }
        };
      
        // Validar tipos
        for (const t of tipos) {
          if (!tipoMap[t]) {
            return c.json({ error: `Tipo inválido: ${t}` }, 400);
          }
        }
      
        // Si no viene ni tipo ni reino, no tiene sentido filtrar
        if (tipos.length === 0 && reinos.length === 0) {
          return c.json({ error: "Debes proporcionar al menos 'tipo' o 'reino'." }, 400);
        }
      
        // 2) Obtener cartas base
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
      
        // Helper para decidir qué reinos aplicar por tabla (tokens solo si incluye NATURA)
        const reinosParaTabla = (table: string): string[] | undefined => {
          if (reinos.length === 0) return undefined; // sin filtro por reino
          if (table === "bestias" || table === "reinas") return reinos;
          if (table === "tokens") {
            return reinos.includes("NATURA") ? ["NATURA"] : []; // vacío => no consultar tokens
          }
          return undefined; // conjuros/recursos no tienen reino
        };
      
        // Helper para cargar subtabla con filtros en chunks
        const fetchSubtable = async (
          table: "bestias"|"reinas"|"tokens"|"conjuros"|"recursos",
          columns: string[],
          reinosFiltro?: string[]
        ): Promise<Record<number, any>> => {
          const combined: Record<number, any> = {};
          // Si la lógica de reinos dice que esta tabla no aplica (tokens sin NATURA), saltar
          if (reinosFiltro && reinosFiltro.length === 0) return combined;
        
          for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const idPlaceholders = chunk.map(() => "?").join(",");
            const cols = columns.length ? `, ${columns.join(",")}` : "";
          
            let query = `SELECT id${cols} FROM ${table} WHERE id IN (${idPlaceholders})`;
            const bind: (number|string)[] = [...chunk];
          
            if (reinosFiltro && ["bestias","reinas","tokens"].includes(table)) {
              const reinoPlaceholders = reinosFiltro.map(() => "?").join(",");
              query += ` AND reino IN (${reinoPlaceholders})`;
              bind.push(...reinosFiltro);
            }
          
            const rows = await env.DB.prepare(query).bind(...bind).all();
            for (const row of rows.results as any[]) {
              combined[row.id] = row;
            }
          }
          return combined;
        };
      
        // 3) Determinar tablas a consultar: unión de
        //    - las requeridas por 'tipos'
        //    - las que aplican por 'reinos' (bestias/reinas y tokens solo si NATURA)
        const tablasPorTipos = new Set(tipos.map(t => tipoMap[t].table));
        if (reinos.length > 0) {
          tablasPorTipos.add("bestias");
          tablasPorTipos.add("reinas");
          if (reinos.includes("NATURA")) tablasPorTipos.add("tokens");
        }
      
        // Cargar mapas de subtablas necesarios
        const needBestias  = tablasPorTipos.has("bestias");
        const needReinas   = tablasPorTipos.has("reinas");
        const needTokens   = tablasPorTipos.has("tokens");
        const needConjuros = tablasPorTipos.has("conjuros");
        const needRecursos = tablasPorTipos.has("recursos");
      
        const bestiasMap  = needBestias  ? await fetchSubtable("bestias",  ["atk","def","lvl","reino","tiene_habilidad_esp"], reinosParaTabla("bestias")) : {};
        const reinasMap   = needReinas   ? await fetchSubtable("reinas",   ["atk","lvl","reino"],                         reinosParaTabla("reinas"))  : {};
        const tokensMap   = needTokens   ? await fetchSubtable("tokens",   ["atk","def","lvl","reino"],                   reinosParaTabla("tokens"))  : {};
        const conjurosMap = needConjuros ? await fetchSubtable("conjuros", ["tipo"]) : {};
        const recursosMap = needRecursos ? await fetchSubtable("recursos", [])      : {};
      
        // 4) Filtrar según reglas combinadas
        const matchByTipos = (id: number): boolean => {
          if (tipos.length === 0) return false;
          return tipos.some(t => {
            const table = tipoMap[t].table;
            return (
              (table === "bestias"  && bestiasMap[id])  ||
              (table === "reinas"   && reinasMap[id])   ||
              (table === "tokens"   && tokensMap[id])   ||
              (table === "conjuros" && conjurosMap[id]) ||
              (table === "recursos" && recursosMap[id])
            );
          });
        };
      
        const matchByReinos = (id: number): boolean => {
          if (reinos.length === 0) return false;
          return !!(bestiasMap[id] || reinasMap[id] || tokensMap[id]);
        };
      
        const filtered = cartas.filter(ca => {
          // Si hay ambos, incluir si cumple cualquiera (union)
          if (tipos.length > 0 && reinos.length > 0) {
            return matchByTipos(ca.id) || matchByReinos(ca.id);
          }
          // Solo tipos
          if (tipos.length > 0) return matchByTipos(ca.id);
          // Solo reinos
          if (reinos.length > 0) return matchByReinos(ca.id);
          return false;
        });
      
        // 5) Armar respuesta
        const result = filtered.map(ca => {
          const obj: any = {
            idFisico: ca.idFisico,
            nombre: ca.nombre,
            descripcion: ca.descripcion,
            tipoCarta: ca.tipoCarta,
          };
          if (bestiasMap[ca.id]) {
            const b = bestiasMap[ca.id];
            obj.atk = b.atk; obj.def = b.def; obj.lvl = b.lvl; obj.reino = b.reino;
            obj.tieneHabilidadEsp = b.tiene_habilidad_esp;
          } else if (reinasMap[ca.id]) {
            const r = reinasMap[ca.id];
            obj.atk = r.atk; obj.lvl = r.lvl; obj.reino = r.reino;
          } else if (tokensMap[ca.id]) {
            const t = tokensMap[ca.id];
            obj.atk = t.atk; obj.def = t.def; obj.lvl = t.lvl; obj.reino = t.reino;
          } else if (conjurosMap[ca.id]) {
            obj.tipo = conjurosMap[ca.id].tipo;
          }
          // recursos no agregan campos adicionales
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
