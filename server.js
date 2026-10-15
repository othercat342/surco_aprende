const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// >>> PEGÁ TU CLAVE DE GEMINI ACÁ (entre las comillas) <<<
// ADVERTENCIA: si subís este archivo a GitHub con la clave puesta,
// GitHub bloquea el push. Antes de subir, volvé a dejar 'PEGA_TU_CLAVE_ACA'.
// ==========================================
const GEMINI_API_KEY_AQUI = 'AQ.Ab8RN6Idzy0mJ1hqG1t7PsloTLQvxMAc38O1n_6xGZ5CazS6bw';

// ==========================================
// ARCHIVO .env (claves y datos privados)
// Si existe un archivo .env al lado de server.js, se cargan sus variables.
// Ese archivo NO se sube a GitHub (lo bloquea .gitignore).
// Formato:  GEMINI_API_KEY=tu_clave
// ==========================================
try {
    require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((linea) => {
        const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || linea.trim().startsWith('#')) return;
        const valor = m[2].replace(/^(['"])(.*)\1$/, '$2');
        if (process.env[m[1]] === undefined) process.env[m[1]] = valor;
    });
} catch (_) { /* no hay .env: se usan las variables del sistema (por ejemplo, las de Railway) */ }

app.use(express.json({ limit: '50kb' }));
app.use(cors());

// ==========================================
// BASE DE DATOS (MySQL)
// Local (XAMPP): usa los valores por defecto de abajo.
// En Railway: define las variables MYSQLHOST, MYSQLUSER, MYSQLPASSWORD,
// MYSQLDATABASE y MYSQLPORT (o DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT).
// ==========================================
const db = mysql.createPool({
    host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD ?? process.env.MYSQLPASSWORD ?? '',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'surco_aprende',
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
    waitForConnections: true,
    connectionLimit: 5
});

// Prueba de conexión al arrancar: si falla, el servidor sigue andando (el chat y la web no la necesitan)
db.query('SELECT 1', (err) => {
    if (err) console.error('MySQL no disponible (la web y el chat siguen funcionando):', err.code || err.message);
    else console.log('¡Conectado exitosamente a la base de datos MySQL!');
});

function consulta(sql) {
    return (req, res) => {
        db.query(sql, (err, results) => {
            if (err) return res.status(500).json({ error: err.code || err.message });
            res.json(results);
        });
    };
}

// ==========================================
// RUTAS DE LA API
// ==========================================
app.get('/api/libros', consulta('SELECT * FROM libros'));
app.get('/api/socios', consulta('SELECT id, nombre, tipo, fecha_registro FROM socios')); // sin el email
app.get('/api/artistas', consulta('SELECT * FROM artistas'));
app.get('/api/practica', consulta('SELECT * FROM practica'));
app.get('/api/prestamos', consulta(`
    SELECT p.id, s.nombre AS socio, l.titulo AS libro, p.fecha_prestamo, p.estado
    FROM prestamos p
    JOIN socios s ON p.id_socio = s.id
    JOIN libros l ON p.id_libro = l.id
`));

// ==========================================
// CHAT CON IA: Cuartetito
// Necesita ANTHROPIC_API_KEY o GEMINI_API_KEY (variable de entorno, nunca en el código).
// ==========================================

// Artistas que Cuartetito conoce (tienen que coincidir con data.js)
const ARTISTS_OK = [
    'Cuarteto de Nos', 'Indio Solari', 'Milo J', 'Callejeros', 'Soda Stereo',
    'Luis Alberto Spinetta', 'Mercedes Sosa', 'Astor Piazzolla', 'Rubén Rada',
    'Jorge Drexler', 'Los Palmeras'
];

const BASE_PROMPT = `Sos Cuartetito, un guía musical simpático dentro de la página "Surco Aprende", pensada para estudiantes de secundaria.
Hablás en español rioplatense (voseo), con respuestas cortas (máximo 120 palabras) y claras.
Solo respondés sobre música: notas, acordes, instrumentos, teoría básica, historia de la música y artistas.
Si te preguntan otra cosa, decilo con simpatía y volvé al tema musical.
No inventes datos: si no estás seguro de algo, decilo.`;

const MODE_PROMPT = {
    charla: 'Modo charla: conversá y explicá con ejemplos simples.',
    profe: 'Modo profe: armá ejercicios concretos y breves que se puedan practicar con el Piano y las herramientas de Práctica (acordes, metrónomo, afinador, progresiones) de la página.'
};

function limpiarMensajes(messages) {
    if (!Array.isArray(messages)) return [];
    const out = messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content.slice(0, 500) }));
    while (out.length && out[0].role !== 'user') out.shift(); // la IA exige empezar con un mensaje del usuario
    return out;
}

// Lee un stream SSE y llama a onData(objetoJSON) por cada evento
async function leerSSE(resp, onData) {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of resp.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try { onData(JSON.parse(data)); } catch (_) { /* línea incompleta o ignorable */ }
        }
    }
}

app.post('/api/chat', async (req, res) => {
    const { artist, mode } = req.body || {};
    const messages = limpiarMensajes(req.body && req.body.messages);
    if (!messages.length) return res.status(400).json({ error: 'Escribí una pregunta para Cuartetito.' });

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY || (GEMINI_API_KEY_AQUI !== 'PEGA_TU_CLAVE_ACA' ? GEMINI_API_KEY_AQUI : '');
    if (!anthropicKey && !geminiKey) {
        return res.status(503).json({ error: 'El chat todavía no está configurado en el servidor.' });
    }

    let system = BASE_PROMPT + '\n' + (MODE_PROMPT[mode] || MODE_PROMPT.charla);
    if (ARTISTS_OK.includes(artist)) system += `\nEl usuario está viendo la sección del artista: ${artist}.`;

    try {
        let upstream;
        if (anthropicKey) {
            upstream = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': anthropicKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
                    max_tokens: 500,
                    stream: true,
                    system,
                    messages
                })
            });
        } else {
            const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
            upstream = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: system }] },
                        contents: messages.map(m => ({
                            role: m.role === 'assistant' ? 'model' : 'user',
                            parts: [{ text: m.content }]
                        })),
                        generationConfig: { maxOutputTokens: 500 }
                    })
                }
            );
        }

        if (!upstream.ok) {
            console.error('Error del proveedor de IA:', upstream.status, await upstream.text().catch(() => ''));
            return res.status(502).json({ error: 'Cuartetito no pudo responder ahora. Probá de nuevo en unos segundos.' });
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        await leerSSE(upstream, (ev) => {
            let texto = '';
            if (anthropicKey) {
                if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) texto = ev.delta.text;
            } else {
                const parts = ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts;
                if (parts) texto = parts.map(p => p.text || '').join('');
            }
            if (texto) res.write(texto);
        });
        res.end();
    } catch (err) {
        console.error('Error en /api/chat:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Cuartetito no pudo responder ahora. Probá de nuevo en unos segundos.' });
        else res.end();
    }
});

// ==========================================
// ARCHIVOS DEL FRONTEND
// Se bloquea el acceso web al código del servidor, al SQL y a los datos privados.
// ==========================================
const PRIVADOS = /^\/(server\.js|database\.sql|package(-lock)?\.json|readme\.md|node_modules|\.)/i;
app.use((req, res, next) => {
    if (PRIVADOS.test(req.path)) return res.status(404).send('No encontrado');
    next();
});
app.use(express.static(__dirname));

app.get('*', (req, res) => {
    if (path.extname(req.path)) return res.status(404).send('No encontrado: ' + req.path);
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
