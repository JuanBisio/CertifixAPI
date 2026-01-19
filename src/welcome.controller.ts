import { Controller, Get } from '@nestjs/common';

@Controller()
export class WelcomeController {
  @Get()
  root() {
    return `
<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>CertiFix - Verificación</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1220;
        --card: #111a2e;
        --border: #1f2a3d;
        --text: #e2e8f0;
        --muted: #94a3b8;
        --primary: #3b82f6;
        --primary-dark: #1d4ed8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: var(--bg);
        color: var(--text);
        display: grid;
        place-items: center;
        min-height: 100vh;
        padding: 24px;
      }
      .card {
        width: min(560px, 100%);
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 32px;
        text-align: center;
        box-shadow: 0 20px 60px rgba(0,0,0,0.35);
      }
      h2 { margin: 0 0 12px 0; font-size: 28px; }
      p { margin: 0 0 16px 0; color: var(--muted); font-size: 16px; line-height: 1.5; }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        margin-top: 8px;
        padding: 14px 18px;
        border-radius: 12px;
        background: linear-gradient(135deg, var(--primary), var(--primary-dark));
        color: white;
        text-decoration: none;
        font-weight: 700;
        font-size: 16px;
        min-width: 220px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>Correo verificado</h2>
      <p>Tu correo fue confirmado correctamente. Ya puedes regresar a la aplicación e iniciar sesión.</p>
      <p>Si abriste este enlace desde el email de confirmación, ya no necesitas hacer nada más.</p>
      <a class="btn" href="#">Volver a la app</a>
    </div>
  </body>
</html>
    `;
  }
}
