import { Hono, Context, Next } from "hono";
import { sign, verify } from "hono/jwt"
import { cors } from "hono/cors";
import { handleRest } from './rest';
import cartasData from './resources/dataset/cartas.json';

export interface Env {
  PLAYFAB_TITLE_ID: string;
  PLAYFAB_SECRET_KEY: string;
  JWT_SECRET: string;
  DB: D1Database;
  ADMIN_TOKEN: SecretsStoreSecret;
  USER_TOKEN: SecretsStoreSecret;
  R2_BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();

    app.use('*', async (c, next) => cors()(c, next));

    // Obtener secreto para auth
    const adminSecret = await env.ADMIN_TOKEN.get();
    //const userSecret = await env.USER_TOKEN.get();

    // Admin (token fijo)
    const adminMiddleware = async (c: Context, next: Next) => {
      const authHeader = c.req.header('Authorization');
      if (!authHeader) return c.json({ error: 'Unauthorized' }, 401);

      const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
      if (token !== adminSecret) return c.json({ error: 'Unauthorized' }, 401);

      return next();
    };

    /*
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
    */


    // 🔐 Middleware para validar JWT en endpoints protegidos
    const userMiddleware = async (c: Context, next: Next) => {
      const authHeader = c.req.header('Authorization');
      if (!authHeader) return c.json({ error: 'Unauthorized' }, 401);

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : authHeader;

      try {
        const userSecret = await c.env.USER_TOKEN.get(); // 👈 aquí
        const payload = await verify(token, userSecret);
        c.set('jwtPayload', payload);
        return next();
      } catch (err) {
        return c.json({ error: 'Unauthorized', message: (err as Error).message }, 401);
      }
    };

    // Endpoint para que un usuario obtenga JWT desde su sessionTicket de PlayFab
    app.post("/get-user-token", async (c) => {
      const body = await c.req.json();
      const { sessionTicket } = body;

      if (!sessionTicket) {
        return c.json({ error: "Missing sessionTicket" }, 400);
      }

      // 1️⃣ Validar ticket con PlayFab
      const resp = await fetch(
        `https://${c.env.PLAYFAB_TITLE_ID}.playfabapi.com/Server/AuthenticateSessionTicket`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SecretKey": c.env.PLAYFAB_SECRET_KEY,
          },
          body: JSON.stringify({ SessionTicket: sessionTicket }),
        }
      );

      if (!resp.ok) {
        return c.json({ error: "Invalid session ticket" }, 401);
      }

      const data: any = await resp.json();

      //ruta real del TitlePlayerAccount
      const playerId = data.data?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id;

      if (!playerId) {
        return c.json({ error: "User not found" }, 401);
      }

      // 2️⃣ Generar JWT firmado con USER_TOKEN
      const payload = {
        sub: playerId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600, // expira en 1h
      };

      // 2️⃣ Generar JWT firmado con USER_TOKEN
      const userSecret = await c.env.USER_TOKEN.get();
      const token = await sign(payload, userSecret);

      return c.json({ token }, 200);
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

    // Endpoint para Buscar cartas con filtros
    app.get("/search-cards", userMiddleware, async (c) => {
      try {
        // 1) Leer parámetros
        const rawIdFisico = c.req.query("idFisico");
        const rawNombre = c.req.query("nombre");
        const rawTipo = c.req.query("tipo");
        const rawReino = c.req.query("reino");
        const rawNivel = c.req.query("nivel");

        // 2) Normalizar filtros
        const tipos: string[] = rawTipo
          ? Array.from(new Set(rawTipo.split(",")
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => s.toUpperCase().replace(/\s+/g, "_"))))
          : [];
        const reinos: string[] = rawReino
          ? Array.from(new Set(rawReino.split(",")
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => s.toUpperCase())))
          : [];
        const niveles: number[] = rawNivel
          ? Array.from(new Set(rawNivel.split(",")
            .map(s => parseInt(s, 10))
            .filter(n => !isNaN(n))))
          : [];

        const validReinos = ["NATURA", "NICROM", "PYRO", "AQUA"];
        for (const r of reinos) {
          if (!validReinos.includes(r))
            return c.json({ error: `Reino inválido: ${r}. Válidos: ${validReinos.join(", ")}` }, 400);
        }

        // Mapear tipos
        const tipoMap: Record<string, { table: "bestias" | "reinas" | "tokens" | "cartas" }> = {
          BESTIA_NORMAL: { table: "bestias" },
          BESTIA_HABILIDAD: { table: "bestias" },
          REINA: { table: "reinas" },
          TOKEN: { table: "tokens" },
          CONJURO_NORMAL: { table: "cartas" },
          CONJURO_CAMPO: { table: "cartas" },
          RECURSO: { table: "cartas" },
        };
        for (const t of tipos) {
          if (!tipoMap[t]) return c.json({ error: `Tipo inválido: ${t}` }, 400);
        }

        // Función para subtablas
        const fetchSubtable = async (table: "bestias" | "reinas" | "tokens", columns: string[], ids: number[]): Promise<Record<number, any>> => {
          const combined: Record<number, any> = {};
          if (!ids.length) return combined;
          const CHUNK_SIZE = 15;
          for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const colsStr = columns.length ? ", " + columns.join(", ") : "";
            const rows = await env.DB.prepare(`SELECT id${colsStr} FROM ${table} WHERE id IN (${placeholders})`).bind(...chunk).all();
            for (const row of rows.results as any[]) combined[row.id] = row;
          }
          return combined;
        };

        // 3) Si idFisico -> prioridad
        if (rawIdFisico) {
          const rows = await env.DB.prepare("SELECT * FROM cartas WHERE id_fisico = ?").bind(rawIdFisico).all();
          if (!rows.results.length) return c.json([]);
          const carta = rows.results[0];
          return c.json([{
            idFisico: carta.id_fisico,
            nombre: carta.nombre,
            descripcion: carta.descripcion,
            tipoCarta: carta.tipo_carta
          }]);
        }

        // 4) Obtener cartas base por tipo/nombre con caso especial AND para tipos con reino
        let cartas: any[] = [];
        const tiposConReino = ["BESTIA_NORMAL", "BESTIA_HABILIDAD", "REINA", "TOKEN"];
        const tiposAND = tipos.filter(t => tiposConReino.includes(t));

        if (tiposAND.length && reinos.length) {
          for (const t of tiposAND) {
            const table = tipoMap[t].table;
            const placeholdersReino = reinos.map(() => "?").join(",");
            let query = `SELECT c.*, s.* 
                    FROM cartas c 
                    JOIN ${table} s ON c.id = s.id 
                    WHERE c.tipo_carta = ? AND s.reino IN (${placeholdersReino})`;
            if (niveles.length) query += ` AND s.lvl IN (${niveles.map(() => "?").join(",")})`;
            if (rawNombre) query += " AND LOWER(c.nombre) LIKE ?";

            const bindParams: any[] = [t, ...reinos];
            if (niveles.length) bindParams.push(...niveles);
            if (rawNombre) bindParams.push(`%${rawNombre.toLowerCase()}%`);

            const rows = await env.DB.prepare(query).bind(...bindParams).all();
            cartas.push(...rows.results);
          }
        }

        // Tipos restantes (conjuros, recursos)
        const tiposRestantes = tipos.filter(t => !tiposConReino.includes(t));
        if (tiposRestantes.length) {
          let query = `SELECT * FROM cartas WHERE tipo_carta IN (${tiposRestantes.map(() => "?").join(",")})`;
          if (rawNombre) query += " AND LOWER(nombre) LIKE ?";
          const bindParams: any[] = [...tiposRestantes];
          if (rawNombre) bindParams.push(`%${rawNombre.toLowerCase()}%`);
          const rows = await env.DB.prepare(query).bind(...bindParams).all();
          cartas.push(...rows.results);
        }

        // Si no se pasó ningún filtro, traer todas las cartas
        if (!tipos.length && !reinos.length && !rawNombre && !niveles.length) {
          const rows = await env.DB.prepare("SELECT * FROM cartas").all();
          cartas.push(...rows.results);
        }

        // 5) Buscar en subtablas si hay reino/nivel
        let subCartas: any[] = [];
        const subtables = [
          { name: "bestias", cols: ["atk", "def", "lvl", "reino", "tiene_habilidad_esp"] },
          { name: "reinas", cols: ["atk", "lvl", "reino"] },
          { name: "tokens", cols: ["atk", "def", "lvl", "reino"] },
        ];

        if (reinos.length || niveles.length || rawNombre) {
          for (const sub of subtables) {
            let query = `SELECT c.*, s.* FROM cartas c JOIN ${sub.name} s ON c.id = s.id WHERE 1=1`;
            const params: any[] = [];

            if (reinos.length) {
              query += ` AND s.reino IN (${reinos.map(() => "?").join(",")})`;
              params.push(...reinos);
            }
            if (niveles.length) {
              query += ` AND s.lvl IN (${niveles.map(() => "?").join(",")})`;
              params.push(...niveles);
            }
            if (rawNombre) {
              query += " AND LOWER(c.nombre) LIKE ?";
              params.push(`%${rawNombre.toLowerCase()}%`);
            }

            const rows = await env.DB.prepare(query).bind(...params).all();
            subCartas.push(...rows.results);
          }
        }

        // 6) Unir ambas colecciones y eliminar duplicados
        let todas = [...cartas, ...subCartas];
        const seen = new Set();
        todas = todas.filter(c => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });
        if (!todas.length) return c.json([]);

        // 7) Enriquecer con subtablas
        const ids = todas.map(c => c.id);
        const tiposSet = new Set(todas.map(c => c.tipo_carta));

        const bestiasMap = (tiposSet.has("BESTIA_NORMAL") || tiposSet.has("BESTIA_HABILIDAD"))
          ? await fetchSubtable("bestias", subtables.find(s => s.name === "bestias")!.cols, ids)
          : {};
        const reinasMap = tiposSet.has("REINA")
          ? await fetchSubtable("reinas", subtables.find(s => s.name === "reinas")!.cols, ids)
          : {};
        const tokensMap = tiposSet.has("TOKEN")
          ? await fetchSubtable("tokens", subtables.find(s => s.name === "tokens")!.cols, ids)
          : {};

        // 8) Merge final
        const result = todas.map(ca => {
          const obj: any = {
            idFisico: ca.id_fisico,
            idGlobal: ca.id_global,
            nombre: ca.nombre,
            descripcion: ca.descripcion,
            tipoCarta: ca.tipo_carta,
          };
          const extra = bestiasMap[ca.id] || reinasMap[ca.id] || tokensMap[ca.id];
          if (extra) {
            obj.atk = extra.atk;
            obj.def = extra.def;
            obj.lvl = extra.lvl;
            obj.reino = extra.reino;
            if ("tiene_habilidad_esp" in extra) obj.tieneHabilidadEsp = extra.tiene_habilidad_esp === 1;
          }
          return obj;
        });

        return c.json(result);

      } catch (err: any) {
        console.error(err);
        return c.json({ error: err.message }, 500);
      }
    });

    // Endpoint para devolver imágenes de cartas desde R2
    app.get("/card-image/:idGlobal", userMiddleware, async (c) => {
      try {
        const idGlobal = c.req.param("idGlobal");
        if (!idGlobal) {
          return c.json({ error: "Falta parámetro idGlobal" }, 400);
        }

        // 🔒 Normalizar (evitar accesos raros tipo ../)
        const safeName = idGlobal.replace(/[^a-zA-Z0-9_-]/g, "");

        // Buscar en R2 (puede ser .png o .jpg, según cómo subas las imágenes)
        const possibleKeys = [`${safeName}.png`, `${safeName}.jpg`];
        let object: R2ObjectBody | null = null;

        for (const key of possibleKeys) {
          const candidate = await env.R2_BUCKET.get(key);
          if (candidate) {
            object = candidate;
            break;
          }
        }

        if (!object) {
          return c.json({ error: `Imagen no encontrada para ${idGlobal}` }, 404);
        }

        // Deducir content-type según extensión
        const contentType = object.key.endsWith(".jpg") || object.key.endsWith(".jpeg")
          ? "image/jpeg"
          : "image/png";

        return new Response(object.body, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400", // cache en clientes/CDN 1 día
          },
        });
      } catch (err: any) {
        console.error("Error en /card-image:", err);
        return c.json({ error: err.message }, 500);
      }
    });

    return app.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
