import { Hono, Context, Next } from "hono";
import { sign, verify } from "hono/jwt"
import { cors } from "hono/cors";
import { handleRest } from './rest';
import cartasData from './resources/dataset/cartas.json';

export interface Env {
  PLAYFAB_TITLE_ID: string;
  //PLAYFAB_SECRET_KEY: string;
  FIREBASE_API_KEY: string;
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
    /*
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
    */

    app.post("/get-user-token", async (c) => {
      const body = await c.req.json();
      const { idToken } = body;
    
      if (!idToken) {
        return c.json({ error: "Missing idToken" }, 400);
      }
    
      try {
        // 1️⃣ Validar idToken con Firebase REST API
        const resp = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${c.env.FIREBASE_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: idToken }),
          }
        );
      
        if (!resp.ok) {
          // puede devolver 400 si token inválido
          return c.json({ error: "Invalid Firebase ID token" }, 401);
        }
      
        const data: any = await resp.json();
      
        const user = data.users?.[0];
        if (!user || !user.localId) {
          return c.json({ error: "User not found" }, 401);
        }
      
        const userId = user.localId;
      
        // Aquí opcionalmente puedes verificar otros datos:
        // user.email, user.emailVerified, user.providerId, etc.
      
        // 2️⃣ Generar JWT firmado con tu secreto
        const payload = {
          sub: userId,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600, // expira en 1 hora
        };
      
        const userSecret = await c.env.USER_TOKEN.get();
        const token = await sign(payload, userSecret);
      
        return c.json({ token }, 200);
      } catch (err: any) {
        console.error("❌ Error al validar Firebase token:", err);
        return c.json({ error: "Internal server error" }, 500);
      }
    });

    const CHUNK_SIZE = 10; // tamaño de lotes para evitar saturar SQLite

    // Tipos de datos
    type Carta = {
      id: number;
      idGlobal: string;
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

    type Conjuro = { id: number; tipo: string };
    type Recurso = { id: number };

    // Endpoint que importa JSON desde archivo para insertar o actualizar en DB
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
      
        // ⚠️ Debug helper para detectar campos undefined
        const checkUndefined = (obj: Record<string, any>, tabla: string) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) console.error(`⚠️ En tabla ${tabla}, el campo "${k}" está undefined`);
          }
        };
      
        // ---------------------
        // UPSERT PARA CARTAS
        // ---------------------
        const upsertCartas = async (cartasChunk: Carta[]) => {
          for (const p of cartasChunk) {
            const obj = {
              id: p.id,
              id_global: p.idGlobal,
              id_fisico: p.idFisico,
              nombre: p.nombre,
              descripcion: p.descripcion,
              tipo_carta: p.tipoCarta,
            };
            checkUndefined(obj, 'cartas');
          
            await env.DB.prepare(`
              INSERT INTO cartas (id, id_global, id_fisico, nombre, descripcion, tipo_carta)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id_global) DO UPDATE SET
                id_fisico = excluded.id_fisico,
                nombre = excluded.nombre,
                descripcion = excluded.descripcion,
                tipo_carta = excluded.tipo_carta
            `)
              .bind(obj.id, obj.id_global, obj.id_fisico, obj.nombre, obj.descripcion, obj.tipo_carta)
              .run();
          }
        };
      
        // ---------------------
        // UPSERTS PARA SUBTABLAS
        // ---------------------
        const upsertBestias = async (bestiasChunk: Bestia[]) => {
          for (const b of bestiasChunk) {
            const obj = {
              id: b.id,
              atk: b.atk,
              def: b.def,
              lvl: b.lvl,
              reino: b.reino,
              tiene_habilidad_esp: b.tieneHabilidadEsp ? 1 : 0,
            };
            checkUndefined(obj, 'bestias');
          
            await env.DB.prepare(`
              INSERT INTO bestias (id, atk, def, lvl, reino, tiene_habilidad_esp)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                atk = excluded.atk,
                def = excluded.def,
                lvl = excluded.lvl,
                reino = excluded.reino,
                tiene_habilidad_esp = excluded.tiene_habilidad_esp
            `)
              .bind(obj.id, obj.atk, obj.def, obj.lvl, obj.reino, obj.tiene_habilidad_esp)
              .run();
          }
        };
      
        const upsertReinas = async (chunk: Reina[]) => {
          for (const r of chunk) {
            const obj = { id: r.id, atk: r.atk, lvl: r.lvl, reino: r.reino };
            checkUndefined(obj, 'reinas');
          
            await env.DB.prepare(`
              INSERT INTO reinas (id, atk, lvl, reino)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                atk = excluded.atk,
                lvl = excluded.lvl,
                reino = excluded.reino
            `)
              .bind(obj.id, obj.atk, obj.lvl, obj.reino)
              .run();
          }
        };
      
        const upsertTokens = async (chunk: Token[]) => {
          for (const t of chunk) {
            const obj = { id: t.id, atk: t.atk, def: t.def, lvl: t.lvl, reino: t.reino };
            checkUndefined(obj, 'tokens');
          
            await env.DB.prepare(`
              INSERT INTO tokens (id, atk, def, lvl, reino)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                atk = excluded.atk,
                def = excluded.def,
                lvl = excluded.lvl,
                reino = excluded.reino
            `)
              .bind(obj.id, obj.atk, obj.def, obj.lvl, obj.reino)
              .run();
          }
        };
      
        const upsertConjuros = async (chunk: Conjuro[]) => {
          for (const cj of chunk) {
            const obj = { id: cj.id, tipo: cj.tipo };
            checkUndefined(obj, 'conjuros');
          
            await env.DB.prepare(`
              INSERT INTO conjuros (id, tipo)
              VALUES (?, ?)
              ON CONFLICT(id) DO UPDATE SET
                tipo = excluded.tipo
            `)
              .bind(obj.id, obj.tipo)
              .run();
          }
        };
      
        const upsertRecursos = async (chunk: Recurso[]) => {
          for (const rc of chunk) {
            const obj = { id: rc.id };
            checkUndefined(obj, 'recursos');
          
            await env.DB.prepare(`
              INSERT INTO recursos (id)
              VALUES (?)
              ON CONFLICT(id) DO NOTHING
            `)
              .bind(obj.id)
              .run();
          }
        };
      
        // ---------------------
        // PROCESAMIENTO POR CHUNKS
        // ---------------------
        for (let i = 0; i < cartas.length; i += CHUNK_SIZE) {
          const cartasChunk = cartas.slice(i, i + CHUNK_SIZE);
        
          // CARTAS (base principal)
          await upsertCartas(cartasChunk);
        
          // SUBTABLAS asociadas
          await upsertBestias(bestias.filter(b => cartasChunk.some(c => c.id === b.id)));
          await upsertReinas(reinas.filter(r => cartasChunk.some(c => c.id === r.id)));
          await upsertTokens(tokens.filter(t => cartasChunk.some(c => c.id === t.id)));
          await upsertConjuros(conjuros.filter(cj => cartasChunk.some(c => c.id === cj.id)));
          await upsertRecursos(recursos.filter(rc => cartasChunk.some(c => c.id === rc.id)));
        }
      
        return c.json({ message: '✅ Importación finalizada con UPSERT' });
      } catch (err: any) {
        console.error("❌ Error en importar-json:", err);
        return c.json({ error: err.message }, 500);
      }
    });

    // Endpoint para Buscar cartas con filtros
    app.get("/search-cards", userMiddleware, async (c) => {
      try {
        // 1) Leer parámetros de query
        const rawIdFisico = c.req.query("idFisico");
        const rawNombre = c.req.query("nombre");
        const rawTipo = c.req.query("tipo");
        const rawReino = c.req.query("reino");
        const rawNivel = c.req.query("nivel");

        // 2) Normalizar filtros
        const tipos: string[] = rawTipo
          ? Array.from(new Set(rawTipo.split(",").map(s => s.trim()).filter(Boolean).map(s => s.toUpperCase().replace(/\s+/g, "_"))))
          : [];
        const reinos: string[] = rawReino
          ? Array.from(new Set(rawReino.split(",").map(s => s.trim()).filter(Boolean).map(s => s.toUpperCase())))
          : [];
        const niveles: number[] = rawNivel
          ? Array.from(new Set(rawNivel.split(",").map(s => parseInt(s, 10)).filter(n => !isNaN(n))))
          : [];

        const validReinos = ["NATURA", "NICROM", "PYRO", "AQUA"];
        for (const r of reinos) {
          if (!validReinos.includes(r))
            return c.json({ error: `Reino inválido: ${r}. Válidos: ${validReinos.join(", ")}` }, 400);
        }

        // 3) Mapear tipos a sus tablas correspondientes
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

        // 4) Función para obtener info de subtablas (bestias, reinas, tokens)
        const fetchSubtable = async (table: "bestias" | "reinas" | "tokens", columns: string[], ids: number[]): Promise<Record<number, any>> => {
          const combined: Record<number, any> = {};
          if (!ids.length) return combined;
          const CHUNK_SIZE = 15; // Por si hay muchos ids, los dividimos en chunks
          for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const colsStr = columns.length ? ", " + columns.join(", ") : "";
            const rows = await env.DB.prepare(`SELECT id${colsStr} FROM ${table} WHERE id IN (${placeholders})`).bind(...chunk).all();
            for (const row of rows.results as any[]) combined[row.id] = row;
          }
          return combined;
        };

        // 5) Caso especial: si se pasa idFisico → traer carta + merge con su subtabla
        if (rawIdFisico) {
          const rows = await env.DB.prepare("SELECT * FROM cartas WHERE id_fisico = ?").bind(rawIdFisico).all();
          if (!rows.results.length) return c.json([]);
          const carta = rows.results[0];

          let extra: any = null;
          if (carta.tipo_carta === "BESTIA_NORMAL" || carta.tipo_carta === "BESTIA_HABILIDAD") {
            const r = await env.DB.prepare("SELECT atk, def, lvl, reino, tiene_habilidad_esp FROM bestias WHERE id = ?").bind(carta.id).all();
            extra = r.results[0] || null;
          } else if (carta.tipo_carta === "REINA") {
            const r = await env.DB.prepare("SELECT atk, lvl, reino FROM reinas WHERE id = ?").bind(carta.id).all();
            extra = r.results[0] || null;
          } else if (carta.tipo_carta === "TOKEN") {
            const r = await env.DB.prepare("SELECT atk, def, lvl, reino FROM tokens WHERE id = ?").bind(carta.id).all();
            extra = r.results[0] || null;
          }

          // 🔀 Merge final (igual que en paso 13)
          const obj: any = {
            idFisico: carta.id_fisico,
            idGlobal: carta.id_global,
            nombre: carta.nombre,
            descripcion: carta.descripcion,
            tipoCarta: carta.tipo_carta,
          };
          if (extra) {
            obj.atk = extra.atk;
            if ("def" in extra) obj.def = extra.def;
            obj.lvl = extra.lvl;
            obj.reino = extra.reino;
            if ("tiene_habilidad_esp" in extra) obj.tieneHabilidadEsp = extra.tiene_habilidad_esp === 1;
          }

          return c.json([obj]);
        }

        // 6) Preparar subtablas con sus columnas
        const subtables = [
          { name: "bestias", cols: ["atk", "def", "lvl", "reino", "tiene_habilidad_esp"] },
          { name: "reinas", cols: ["atk", "lvl", "reino"] },
          { name: "tokens", cols: ["atk", "def", "lvl", "reino"] },
        ];

        let cartas: any[] = [];
        const tiposConReino = ["BESTIA_NORMAL", "BESTIA_HABILIDAD", "REINA", "TOKEN"];
        const tiposAND = tipos.filter(t => tiposConReino.includes(t));

        // 7) Filtrado dinámico AND para tipos especiales
        if (tiposAND.length) {
          for (const t of tiposAND) {
            const table = tipoMap[t].table;
            let query = `SELECT c.*, s.* 
            FROM cartas c 
            JOIN ${table} s ON c.id = s.id 
            WHERE c.tipo_carta = ?`;
            const bindParams: any[] = [t];

            if (reinos.length) {
              query += ` AND s.reino IN (${reinos.map(() => "?").join(",")})`;
              bindParams.push(...reinos);
            }
            if (niveles.length) {
              query += ` AND s.lvl IN (${niveles.map(() => "?").join(",")})`;
              bindParams.push(...niveles);
            }
            if (rawNombre) {
              query += " AND LOWER(c.nombre) LIKE ?";
              bindParams.push(`%${rawNombre.toLowerCase()}%`);
            }

            const rows = await env.DB.prepare(query).bind(...bindParams).all();
            cartas.push(...rows.results);
          }
        }

        // 8) Tipos restantes (conjuros, recursos) se filtran normalmente
        const tiposRestantes = tipos.filter(t => !tiposConReino.includes(t));
        if (tiposRestantes.length) {
          let query = `SELECT * FROM cartas WHERE tipo_carta IN (${tiposRestantes.map(() => "?").join(",")})`;
          const bindParams: any[] = [...tiposRestantes];
          if (rawNombre) {
            query += " AND LOWER(nombre) LIKE ?";
            bindParams.push(`%${rawNombre.toLowerCase()}%`);
          }
          const rows = await env.DB.prepare(query).bind(...bindParams).all();
          cartas.push(...rows.results);
        }

        // 9) Si no se pasa ningún filtro, traer todas las cartas
        if (!tipos.length && !reinos.length && !rawNombre && !niveles.length) {
          const rows = await env.DB.prepare("SELECT * FROM cartas").all();
          cartas.push(...rows.results);
        }

        // 10) Subtablas si no se filtró por tipo
        let subCartas: any[] = [];
        if (!tiposAND.length && (reinos.length || niveles.length || rawNombre)) {
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

        // 11) Unir resultados y eliminar duplicados
        let todas = [...cartas, ...subCartas];
        const seen = new Set();
        todas = todas.filter(c => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });
        if (!todas.length) return c.json([]);

        // 12) Enriquecer con info de subtablas
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

        // 13) Merge final para resultados múltiples
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
            if ("def" in extra) obj.def = extra.def;
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
