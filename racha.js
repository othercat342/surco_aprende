/* ===== RACHA DE PRÁCTICA (estilo Duolingo) =====
   Cuenta un día cuando la persona hace algo en la página (toca el piano, elige un artista, usa una herramienta...).
   Solo se guarda para quienes tienen cuenta. */
(() => {
  const $ = (id) => document.getElementById(id);
  const chip = $("streakChip"), toastEl = $("toast");
  if (!chip) return;

  let logueado = false, hecho = false, enviando = false, avisoTimer;

  const hoy = () => {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };
  const dias = (n) => n + (n === 1 ? " día" : " días");

  function toast(html) {
    clearTimeout(avisoTimer);
    toastEl.innerHTML = html;
    toastEl.hidden = false;
    avisoTimer = setTimeout(() => { toastEl.hidden = true; }, 7000);
  }

  function pintar(s) {
    hecho = s.hecho;
    chip.hidden = false;
    chip.classList.toggle("off", !s.hecho);
    $("streakNum").textContent = s.actual;
    $("streakBig").textContent = s.actual;
    $("streakBest").textContent = s.mejor;
    $("streakMsg").textContent = s.hecho
      ? "¡Listo por hoy! Volvé mañana para seguir sumando."
      : s.actual > 0 ? "Practicá hoy para no perder tu racha." : "Practicá hoy para empezar tu racha.";
    const letras = ["D", "L", "M", "M", "J", "V", "S"];
    $("weekDots").innerHTML = s.semana.map((d, i) =>
      `<li class="${d.hecho ? "hecho" : ""}${i === 6 ? " hoy" : ""}"><i></i>${letras[new Date(d.dia + "T00:00:00").getDay()]}</li>`
    ).join("");
  }

  async function llamar(metodo) {
    const r = await fetch("/api/racha" + (metodo === "GET" ? "?hoy=" + hoy() : ""), {
      method: metodo,
      headers: { "Content-Type": "application/json" },
      body: metodo === "POST" ? JSON.stringify({ hoy: hoy() }) : undefined
    });
    if (!r.ok) throw new Error("racha");
    return r.json();
  }

  async function cargar() {
    try {
      const s = await llamar("GET");
      pintar(s);
      if (!s.hecho) {
        toast(s.actual > 0
          ? `¡Hoy todavía no practicaste! Tu racha de ${dias(s.actual)} está en juego 🔥<br>Tocá una nota o elegí un artista.`
          : "Empezá tu racha de hoy 🔥<br>Tocá una nota o elegí un artista.");
      }
    } catch (_) { chip.hidden = true; }
  }

  async function marcar() {
    if (!logueado || hecho || enviando) return;
    enviando = true;
    try {
      const s = await llamar("POST");
      pintar(s);
      if (s.nuevo) toast(s.actual <= 1 ? "¡Empezaste tu racha! 🔥" : `¡Racha de ${dias(s.actual)}! 🔥`);
    } catch (_) { /* si falla, se reintenta con la próxima acción */ }
    enviando = false;
  }

  document.addEventListener("usuario", (e) => {
    logueado = !!e.detail;
    if (logueado) { cargar(); return; }
    chip.hidden = true;
    hecho = false;
    try {
      if (!sessionStorage.getItem("surcoAvisoRacha")) {
        sessionStorage.setItem("surcoAvisoRacha", "1");
        toast('Creá una cuenta y llevá tu racha de práctica 🔥 <a href="#cuenta">Crear cuenta</a>');
      }
    } catch (_) {}
  });

  // Cualquier acción en la página (menos la sección de cuenta) cuenta como práctica
  document.addEventListener("click", (e) => {
    const main = e.target.closest("main");
    if (main && !e.target.closest("#cuenta")) marcar();
  });
  document.addEventListener("keydown", (e) => {
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) marcar();
  });
})();
