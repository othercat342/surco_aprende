const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

if (typeof fetch !== 'function') {
    console.error('Tu versión de Node (' + process.version + ') es muy vieja: el chat necesita Node 18 o superior.');
}

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// >>> PEGÁ TU CLAVE DE GEMINI ACÁ (entre las comillas) <<<
// ADVERTENCIA: si subís este archivo a GitHub con la clave puesta,
// GitHub bloquea el push. Antes de subir, volvé a dejar 'PEGA_TU_CLAVE_ACA'.
// ==========================================
const GEMINI_API_KEY_AQUI = 'PEGA_TU_CLAVE_ACA';

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
// CUENTAS DE USUARIO (registro, ingreso y sesión)
// Sin librerías extra: contraseñas con scrypt y sesión en cookie firmada (HttpOnly).
// En producción definí SESSION_SECRET (un texto largo y aleatorio); si no, las sesiones
// se cierran cada vez que se reinicia el servidor.
// ==========================================
const crypto = require('crypto');
app.set('trust proxy', 1);

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('Aviso: falta SESSION_SECRET; las sesiones se pierden al reiniciar.');
const COOKIE = 'surco_sesion';
const DURACION_MS = 30 * 24 * 60 * 60 * 1000;

(async () => {
    try {
        const q = db.promise();
        await q.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nombre VARCHAR(60) NOT NULL,
            email VARCHAR(100) NOT NULL UNIQUE,
            password_hash VARCHAR(200) NULL,
            google_id VARCHAR(40) NULL UNIQUE,
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB`);
        await q.query(`CREATE TABLE IF NOT EXISTS racha_dias (
            usuario_id INT NOT NULL,
            dia DATE NOT NULL,
            PRIMARY KEY (usuario_id, dia),
            CONSTRAINT fk_racha_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
        ) ENGINE=InnoDB`);
        // Si la tabla ya existía de antes: permitir cuentas sin contraseña y sumar google_id
        await q.query('ALTER TABLE usuarios MODIFY password_hash VARCHAR(200) NULL');
        await q.query('ALTER TABLE usuarios ADD COLUMN google_id VARCHAR(40) NULL UNIQUE').catch((e) => {
            if (e.code !== 'ER_DUP_FIELDNAME') throw e;
        });
    } catch (err) {
        console.error('No se pudo preparar la tabla usuarios:', err.code || err.message);
    }
})();

function hashPassword(pass) {
    const salt = crypto.randomBytes(16);
    return salt.toString('hex') + ':' + crypto.scryptSync(pass, salt, 64).toString('hex');
}
function verificarPassword(pass, guardado) {
    const [salt, hash] = String(guardado || '').split(':');
    if (!salt || !hash) return false;
    const calc = crypto.scryptSync(pass, Buffer.from(salt, 'hex'), 64);
    const orig = Buffer.from(hash, 'hex');
    return calc.length === orig.length && crypto.timingSafeEqual(calc, orig);
}
const DUMMY_HASH = hashPassword('relleno-para-igualar-tiempos');

function firmar(texto) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(texto).digest('base64url');
}
function crearToken(id) {
    const cuerpo = Buffer.from(JSON.stringify({ id, exp: Date.now() + DURACION_MS })).toString('base64url');
    return cuerpo + '.' + firmar(cuerpo);
}
function leerToken(token) {
    const [cuerpo, firma] = String(token || '').split('.');
    if (!cuerpo || !firma) return null;
    const esperada = Buffer.from(firmar(cuerpo));
    const recibida = Buffer.from(firma);
    if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
    try {
        const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
        return datos.exp > Date.now() ? datos : null;
    } catch (_) { return null; }
}
function cookieDe(req, nombre) {
    const par = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(nombre + '='));
    return par ? decodeURIComponent(par.slice(nombre.length + 1)) : '';
}
function ponerCookie(req, res, valor, maxAgeMs) {
    res.append('Set-Cookie', `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}` + (req.secure ? '; Secure' : ''));
}

// Límite simple de intentos por IP (10 cada 15 minutos) contra fuerza bruta
const intentos = new Map();
function limitar(req, res, next) {
    const ahora = Date.now();
    const reg = intentos.get(req.ip);
    if (!reg || reg.reset < ahora) { intentos.set(req.ip, { n: 1, reset: ahora + 15 * 60 * 1000 }); return next(); }
    if (++reg.n > 10) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
    next();
}
setInterval(() => { const t = Date.now(); intentos.forEach((v, k) => { if (v.reset < t) intentos.delete(k); }); }, 10 * 60 * 1000).unref();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post('/api/registro', limitar, async (req, res) => {
    const nombre = String(req.body.nombre || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (nombre.length < 2 || nombre.length > 60) return res.status(400).json({ error: 'El nombre tiene que tener entre 2 y 60 letras.' });
    if (!EMAIL_RE.test(email) || email.length > 100) return res.status(400).json({ error: 'Ese email no parece válido.' });
    if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres.' });
    try {
        const [r] = await db.promise().query('INSERT INTO usuarios (nombre, email, password_hash) VALUES (?, ?, ?)', [nombre, email, hashPassword(password)]);
        ponerCookie(req, res, crearToken(r.insertId), DURACION_MS);
        res.status(201).json({ usuario: { id: r.insertId, nombre, email } });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya hay una cuenta con ese email.' });
        console.error('Error en registro:', err.code || err.message);
        res.status(500).json({ error: 'No pudimos crear la cuenta. Probá de nuevo más tarde.' });
    }
});

app.post('/api/login', limitar, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    try {
        const [filas] = await db.promise().query('SELECT id, nombre, email, password_hash FROM usuarios WHERE email = ?', [email]);
        const u = filas[0];
        const ok = verificarPassword(password, u ? u.password_hash : DUMMY_HASH) && u;
        if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
        ponerCookie(req, res, crearToken(u.id), DURACION_MS);
        res.json({ usuario: { id: u.id, nombre: u.nombre, email: u.email } });
    } catch (err) {
        console.error('Error en login:', err.code || err.message);
        res.status(500).json({ error: 'No pudimos iniciar sesión. Probá de nuevo más tarde.' });
    }
});

app.post('/api/logout', (req, res) => {
    ponerCookie(req, res, '', 0);
    res.json({ ok: true });
});

app.get('/api/yo', async (req, res) => {
    const sesion = leerToken(cookieDe(req, COOKIE));
    if (!sesion) return res.json({ usuario: null });
    try {
        const [filas] = await db.promise().query('SELECT id, nombre, email FROM usuarios WHERE id = ?', [sesion.id]);
        res.json({ usuario: filas[0] || null });
    } catch (_) { res.json({ usuario: null }); }
});

// ------------------------------------------
// Ingreso con Google (Google Identity Services)
// Necesita GOOGLE_CLIENT_ID en el .env y "npm install" (google-auth-library).
// ------------------------------------------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
let googleClient = null;
if (GOOGLE_CLIENT_ID) {
    try {
        const { OAuth2Client } = require('google-auth-library');
        googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
    } catch (_) {
        console.error('Falta la librería de Google: ejecutá "npm install" para activar el ingreso con Google.');
    }
}

// El front pregunta acá si tiene que mostrar el botón de Google
app.get('/api/config', (req, res) => {
    res.json({ googleClientId: googleClient ? GOOGLE_CLIENT_ID : '' });
});

app.post('/api/login-google', limitar, async (req, res) => {
    if (!googleClient) return res.status(503).json({ error: 'El ingreso con Google no está configurado.' });

    // Paso 1: verificar el token con Google
    let p;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: String(req.body.credential || ''), audience: GOOGLE_CLIENT_ID });
        p = ticket.getPayload();
    } catch (err) {
        console.error('Login con Google: el token no se pudo verificar:', err.message);
        return res.status(401).json({ error: 'Google rechazó el ingreso. Revisá que el ID de cliente del servidor sea el correcto.' });
    }
    if (!p || !p.email || !p.email_verified) return res.status(401).json({ error: 'Google no verificó tu email.' });

    // Paso 2: buscar o crear el usuario en MySQL
    try {
        const email = p.email.toLowerCase();
        const nombre = String(p.name || email.split('@')[0]).trim().slice(0, 60) || 'Usuario';
        const q = db.promise();

        const [filas] = await q.query('SELECT id, nombre, email, google_id FROM usuarios WHERE google_id = ? OR email = ? LIMIT 1', [p.sub, email]);
        let u = filas[0];
        if (!u) {
            const [r] = await q.query('INSERT INTO usuarios (nombre, email, google_id) VALUES (?, ?, ?)', [nombre, email, p.sub]);
            u = { id: r.insertId, nombre, email };
        } else if (!u.google_id) {
            // Ya tenía cuenta con ese email: se vincula con Google
            await q.query('UPDATE usuarios SET google_id = ? WHERE id = ?', [p.sub, u.id]);
        }
        ponerCookie(req, res, crearToken(u.id), DURACION_MS);
        res.json({ usuario: { id: u.id, nombre: u.nombre, email: u.email } });
    } catch (err) {
        console.error('Login con Google: falló la base de datos:', err.code || '', err.message);
        res.status(500).json({ error: 'Google te reconoció, pero no pudimos guardar tu cuenta (problema con la base de datos).' });
    }
});

// ------------------------------------------
// DIAGNÓSTICO TEMPORAL: abrí /api/diagnostico en el navegador para ver por qué falla MySQL.
// Cuando ya ande todo, borrá este bloque.
// ------------------------------------------
app.get('/api/diagnostico', async (req, res) => {
    const out = { variables: {} };
    ['MYSQLHOST', 'MYSQLUSER', 'MYSQLPASSWORD', 'MYSQLDATABASE', 'MYSQLPORT'].forEach((k) => { out.variables[k] = process.env[k] ? 'definida' : 'FALTA'; });
    out.usa_localhost = (process.env.DB_HOST || process.env.MYSQLHOST || 'localhost') === 'localhost';
    try {
        await db.promise().query('SELECT 1');
        out.conexion = 'OK';
    } catch (err) {
        out.conexion = 'FALLA';
        out.codigo_error = err.code || 'desconocido';
        return res.json(out);
    }
    try {
        const [cols] = await db.promise().query('SHOW COLUMNS FROM usuarios');
        out.tabla_usuarios = 'OK';
        out.columnas = cols.map((c) => c.Field);
    } catch (err) {
        out.tabla_usuarios = 'FALLA';
        out.codigo_error = err.code || 'desconocido';
    }
    res.json(out);
});

// ------------------------------------------
// RACHA DE PRÁCTICA (estilo Duolingo)
// Cada día en que la persona practica se guarda una fila en racha_dias.
// La racha es la cantidad de días seguidos; si hoy todavía no practicó, sigue viva si practicó ayer.
// ------------------------------------------
function sumarDias(str, n) {
    const d = new Date(str + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function calcularRacha(dias, hoy) {
    const set = new Set(dias);
    const hecho = set.has(hoy);
    let cursor = hecho ? hoy : sumarDias(hoy, -1), actual = 0;
    while (set.has(cursor)) { actual++; cursor = sumarDias(cursor, -1); }
    let mejor = 0, corrida = 0, previo = null;
    for (const d of [...set].sort()) {
        corrida = previo && sumarDias(previo, 1) === d ? corrida + 1 : 1;
        mejor = Math.max(mejor, corrida);
        previo = d;
    }
    const semana = [];
    for (let i = 6; i >= 0; i--) { const d = sumarDias(hoy, -i); semana.push({ dia: d, hecho: set.has(d) }); }
    return { actual, mejor, hecho, semana };
}
// El día lo manda el navegador (así cuenta según la hora de cada persona); se valida que sea razonable
function diaValido(v) {
    v = String(v || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const t = Date.parse(v + 'T00:00:00Z');
    if (isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return null;
    return Math.abs(t - Date.now()) > 2 * 86400000 ? null : v;
}
function usuarioId(req) {
    const sesion = leerToken(cookieDe(req, COOKIE));
    return sesion ? sesion.id : null;
}
async function estadoRacha(uid, hoy) {
    const [filas] = await db.promise().query("SELECT DATE_FORMAT(dia, '%Y-%m-%d') AS dia FROM racha_dias WHERE usuario_id = ? ORDER BY dia DESC LIMIT 1000", [uid]);
    return calcularRacha(filas.map((f) => f.dia), hoy);
}

app.get('/api/racha', async (req, res) => {
    const uid = usuarioId(req);
    if (!uid) return res.status(401).json({ error: 'Iniciá sesión para llevar tu racha.' });
    const hoy = diaValido(req.query.hoy);
    if (!hoy) return res.status(400).json({ error: 'Fecha inválida.' });
    try { res.json(await estadoRacha(uid, hoy)); }
    catch (err) { console.error('Error al leer la racha:', err.code || '', err.message); res.status(500).json({ error: 'No pudimos leer tu racha.' }); }
});

app.post('/api/racha', async (req, res) => {
    const uid = usuarioId(req);
    if (!uid) return res.status(401).json({ error: 'Iniciá sesión para llevar tu racha.' });
    const hoy = diaValido(req.body.hoy);
    if (!hoy) return res.status(400).json({ error: 'Fecha inválida.' });
    try {
        const [r] = await db.promise().query('INSERT IGNORE INTO racha_dias (usuario_id, dia) VALUES (?, ?)', [uid, hoy]);
        res.json({ ...(await estadoRacha(uid, hoy)), nuevo: r.affectedRows === 1 });
    } catch (err) {
        console.error('Error al guardar la racha:', err.code || '', err.message);
        res.status(500).json({ error: 'No pudimos guardar tu racha.' });
    }
});

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
            // Si el modelo principal está saturado (503) o sin cuota (429), se prueba con el de respaldo.
            const modelos = [
                process.env.GEMINI_MODEL || 'gemini-3.5-flash',
                process.env.GEMINI_MODEL_RESPALDO || 'gemini-3.1-flash-lite'
            ].filter((m, i, arr) => m && arr.indexOf(m) === i);
            const cuerpoGemini = JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: messages.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                })),
                generationConfig: { maxOutputTokens: 1500 }
            });
            for (const model of modelos) {
                upstream = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
                    {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
                        body: cuerpoGemini
                    }
                );
                if (upstream.ok || ![429, 500, 503].includes(upstream.status)) break;
                console.error(`Gemini (${model}) respondió ${upstream.status}, probando el modelo de respaldo...`);
            }
        }

        if (!upstream.ok) {
            const cuerpo = await upstream.text().catch(() => '');
            console.error('Error del proveedor de IA:', upstream.status, cuerpo);
            let motivo = '';
            try { const j = JSON.parse(cuerpo); motivo = (j.error && j.error.message) || ''; } catch (_) { motivo = cuerpo; }
            if ([429, 503].includes(upstream.status)) {
                return res.status(502).json({ error: 'Cuartetito está con mucha demanda en este momento. Probá de nuevo en unos segundos.' });
            }
            // Se muestra el motivo para poder diagnosticar. Antes de la expo se puede reemplazar por un mensaje simple.
            return res.status(502).json({ error: `Cuartetito no pudo responder (error ${upstream.status}): ${String(motivo).slice(0, 200)}` });
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
        const causa = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'desconocido';
        if (!res.headersSent) res.status(500).json({ error: `Cuartetito no pudo responder (${causa}).` });
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
