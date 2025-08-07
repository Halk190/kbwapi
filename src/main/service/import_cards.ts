import * as fs from 'fs';
import * as path from 'path';
import { drizzle } from 'drizzle-orm/d1';
import { importarCartas } from '../src/logic/importar'; // o como tengas la función
import { D1Database } from '@cloudflare/workers-types'; // si estás usando TS

const main = async () => {
    const env = {
    DB: {
      // @ts-ignore: Esta es una simulación para drizzle
        prepare: (query: string) => ({
        async all() {
            console.log('Simulando ejecución:', query);
            return [];
        },
        async run() {
            console.log('Simulando ejecución:', query);
        },
        }),
    } as D1Database,
    };

    try {
        await importarCartas(env);
        console.log('✅ Cartas importadas correctamente');
    } catch (err: any) {
        console.error('❌ Error al importar cartas:', err.message);
    }
};

main();