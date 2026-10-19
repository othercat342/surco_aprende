/* ===== CUENTA: registro, ingreso y sesión ===== */
document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  const form = $("authForm"), err = $("authErr"), submit = $("authSubmit");
  if (!form) return;

  let modo = "login";

  function setModo(m) {
    modo = m;
    const reg = m === "registro";
    $("tabLogin").setAttribute("aria-pressed", String(!reg));
    $("tabRegistro").setAttribute("aria-pressed", String(reg));
    $("nombreRow").hidden = !reg;
    $("passHint").hidden = !reg;
    $("aPass").autocomplete = reg ? "new-password" : "current-password";
    submit.textContent = reg ? "Crear cuenta" : "Ingresar";
    err.textContent = "";
  }

  function mostrarUsuario(u) {
    $("guestBox").hidden = !!u;
    $("userBox").hidden = !u;
    $("cuentaTitle").textContent = u ? "Hola, " + u.nombre : "Tu cuenta";
    $("userHello").textContent = u ? "Sesión iniciada con " + u.email + "." : "";
    $("accountLink").textContent = u ? u.nombre : "Ingresar";
    $("drawerAccount").textContent = u ? "Mi cuenta" : "Ingresar";
    document.body.dataset.user = u ? u.nombre : "";
  }

  async function api(url, datos) {
    const r = await fetch(url, {
      method: datos === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: datos === undefined ? undefined : JSON.stringify(datos)
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.error || "Algo salió mal. Probá de nuevo.");
    return json;
  }

  $("tabLogin").addEventListener("click", () => setModo("login"));
  $("tabRegistro").addEventListener("click", () => setModo("registro"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    submit.disabled = true;
    try {
      const datos = { email: $("aEmail").value, password: $("aPass").value };
      if (modo === "registro") datos.nombre = $("aNombre").value;
      const { usuario } = await api(modo === "registro" ? "/api/registro" : "/api/login", datos);
      form.reset();
      mostrarUsuario(usuario);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/logout", {}); } catch (_) {}
    mostrarUsuario(null);
  });

  // ----- Ingreso con Google (solo si el servidor tiene GOOGLE_CLIENT_ID) -----
  function iniciarGoogle(clientId) {
    const arrancar = () => {
      google.accounts.id.initialize({
        client_id: clientId,
        callback: async (resp) => {
          err.textContent = "";
          try {
            const { usuario } = await api("/api/login-google", { credential: resp.credential });
            mostrarUsuario(usuario);
          } catch (ex) {
            err.textContent = ex.message;
          }
        }
      });
      google.accounts.id.renderButton($("googleBtn"), { theme: "filled_black", size: "large", shape: "pill", text: "continue_with", locale: "es" });
      $("googleSep").hidden = false;
    };
    if (window.google && google.accounts) return arrancar();
    const sc = document.createElement("script");
    sc.src = "https://accounts.google.com/gsi/client";
    sc.async = true;
    sc.onload = arrancar;
    document.head.appendChild(sc);
  }
  api("/api/config").then(({ googleClientId }) => { if (googleClientId) iniciarGoogle(googleClientId); }).catch(() => {});

  // Al cargar la página, ver si ya hay una sesión abierta (si no hay servidor, queda como invitado)
  api("/api/yo").then(({ usuario }) => mostrarUsuario(usuario)).catch(() => mostrarUsuario(null));
});
