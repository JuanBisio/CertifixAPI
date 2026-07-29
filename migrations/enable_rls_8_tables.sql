-- Hallazgo ERROR de Supabase Advisors (ROADMAP.md sección 3, detectado 2026-07-25):
-- RLS deshabilitado en perfiles, perfiles_prestadores, rubros, solicitudes_trabajo,
-- evidencias, disputas, postulaciones y solicitud_candidatos — de acceso público
-- de lectura/escritura a cualquiera con la anon key.
--
-- Hallazgo adicional encontrado al diseñar esta migración (2026-07-27): con RLS
-- deshabilitado en solicitudes_trabajo, la suscripción de Realtime de la app móvil
-- (hooks/useSolicitudesRealtime.ts), que usa el cliente anon sin JWT, recibía TODAS
-- las filas completas de TODAS las solicitudes por Postgres changefeed — incluyendo
-- direccion_exacta/ubicacion_real, salteándose por completo la lógica de privacidad
-- de ubicacion_difusa. Esta migración lo cierra (ver política de SELECT abajo); el
-- fix del lado mobile (pasar a usar el cliente autenticado) va en el mismo commit.
--
-- Diseño: mismo criterio ya usado en mensajes_select/mensajes_insert (única RLS
-- ya aplicada en este proyecto sobre una tabla con reglas de negocio no triviales,
-- ver migrations de la sección 2.5 del ROADMAP) — policies "TO public" que usan
-- auth.uid() en la condición, así anon (sin JWT, auth.uid() IS NULL) queda
-- excluido automáticamente sin necesitar policies separadas por rol.
--
-- El backend hace la enorme mayoría de sus queries con el JWT del propio usuario
-- (SupabaseService.getAuthenticatedClient), así que estas policies tienen que ser
-- al menos tan permisivas como lo que esos ~30 call-sites de
-- solicitudes.service.ts/profiles.service.ts/evidencias.service.ts/disputas.service.ts
-- ya necesitan hoy (auditados uno por uno para esta migración) — la lógica de qué
-- transición de estado es válida sigue viviendo en el backend (esta migración no la
-- reimplementa), las policies solo acotan qué filas puede tocar cada usuario.
--
-- Excepción documentada, no resuelta acá: `perfiles_prestadores` guarda URLs de
-- documentos de verificación (DNI, matrícula) y queda con SELECT amplio para
-- cualquier autenticado, porque el flujo de elegir candidato (cliente lee
-- esta_verificado/disponible de un prestador que no es él) y el matching
-- (get_prestadores_para_solicitud, corre con el JWT del cliente que crea la
-- solicitud) ya dependían de poder leer filas ajenas de esta tabla antes de esta
-- migración. RLS es a nivel de fila, no de columna — separar esas URLs a una tabla
-- aparte con RLS propia es un cambio más grande, no incluido acá.

-- ─── rubros: dato de referencia público, sin cambios de comportamiento ────────
ALTER TABLE rubros ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rubros_select_publico"
  ON rubros FOR SELECT
  TO public
  USING (true);
-- Sin policy de INSERT/UPDATE/DELETE: RubrosService únicamente usa el
-- service_role (bypassa RLS), confirmado en rubros.service.ts.

-- ─── perfiles ──────────────────────────────────────────────────────────────
ALTER TABLE perfiles ENABLE ROW LEVEL SECURITY;

-- Lectura amplia para cualquier usuario logueado: ya se necesitaba así hoy
-- (getPublicProfile lee el nombre de un prestador cualquiera; los joins de
-- solicitudes_trabajo devuelven nombre/teléfono de la contraparte). Cierra el
-- acceso anónimo, que es lo que pedía el advisory.
CREATE POLICY "perfiles_select_autenticado"
  ON perfiles FOR SELECT
  TO public
  USING (auth.uid() IS NOT NULL);

-- Solo el dueño puede editar su propio perfil (mismo chequeo que ya hace
-- ProfilesService.updateProfile a nivel de aplicación).
CREATE POLICY "perfiles_update_propio"
  ON perfiles FOR UPDATE
  TO public
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
-- Sin policy de INSERT: el alta de perfil en el registro pasa a hacerse con el
-- service_role (fix aplicado en auth.service.ts en el mismo cambio), así que no
-- hace falta abrir INSERT a authenticated.

-- ─── perfiles_prestadores ──────────────────────────────────────────────────
ALTER TABLE perfiles_prestadores ENABLE ROW LEVEL SECURITY;

-- Ver nota de "Excepción documentada" arriba.
CREATE POLICY "perfiles_prestadores_select_autenticado"
  ON perfiles_prestadores FOR SELECT
  TO public
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "perfiles_prestadores_insert_propio"
  ON perfiles_prestadores FOR INSERT
  TO public
  WITH CHECK (id = auth.uid());

CREATE POLICY "perfiles_prestadores_update_propio"
  ON perfiles_prestadores FOR UPDATE
  TO public
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
-- La verificación admin (esta_verificado) sigue viviendo en admin.service.ts,
-- que usa service_role — no depende de esta policy y no le da a un prestador
-- forma de auto-verificarse.

-- ─── solicitudes_trabajo ───────────────────────────────────────────────────
ALTER TABLE solicitudes_trabajo ENABLE ROW LEVEL SECURITY;

-- Cubre: dueño (cliente), prestador asignado, prestador navegando el pool de
-- "buscando" (verificado + disponible, igual que findAll()/accept()), y
-- candidato ya postulado a una solicitud programada (igual que el bypass
-- esCandidato de findOne() y getMisPostulaciones()).
CREATE POLICY "solicitudes_trabajo_select"
  ON solicitudes_trabajo FOR SELECT
  TO public
  USING (
    cliente_id = auth.uid()
    OR prestador_id = auth.uid()
    OR (
      estado = 'buscando'
      AND EXISTS (
        SELECT 1 FROM perfiles_prestadores pp
        WHERE pp.id = auth.uid() AND pp.esta_verificado = true AND pp.disponible = true
      )
    )
    OR EXISTS (
      SELECT 1 FROM solicitud_candidatos c
      WHERE c.solicitud_id = solicitudes_trabajo.id AND c.prestador_id = auth.uid()
    )
  );

-- Solo un cliente crea su propia solicitud (create()).
CREATE POLICY "solicitudes_trabajo_insert_cliente"
  ON solicitudes_trabajo FOR INSERT
  TO public
  WITH CHECK (
    cliente_id = auth.uid()
    AND EXISTS (SELECT 1 FROM perfiles p WHERE p.id = auth.uid() AND p.rol = 'cliente')
  );

-- USING cubre las filas que cada flujo necesita tocar en su estado previo:
--   - cliente/prestador dueños (updateStatus, cancel, elegirCandidato-por-cliente)
--   - prestador tomando una fila sin asignar en 'buscando' (accept(), y el UPDATE
--     interno de la RPC postularse_a_solicitud que incrementa candidatos_count)
-- WITH CHECK cubre los estados resultantes válidos de esos mismos flujos,
-- incluyendo cuando el prestador cancela y la libera de nuevo a 'buscando' con
-- prestador_id NULL (cancel() como prestador) — solo alcanzable si USING ya
-- validó que esa fila era suya antes del UPDATE.
CREATE POLICY "solicitudes_trabajo_update"
  ON solicitudes_trabajo FOR UPDATE
  TO public
  USING (
    cliente_id = auth.uid()
    OR prestador_id = auth.uid()
    OR (
      estado = 'buscando'
      AND prestador_id IS NULL
      AND EXISTS (
        SELECT 1 FROM perfiles_prestadores pp
        WHERE pp.id = auth.uid() AND pp.esta_verificado = true AND pp.disponible = true
      )
    )
  )
  WITH CHECK (
    cliente_id = auth.uid()
    OR prestador_id = auth.uid()
    OR (estado = 'buscando' AND prestador_id IS NULL)
  );

-- ─── solicitud_candidatos ──────────────────────────────────────────────────
ALTER TABLE solicitud_candidatos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "solicitud_candidatos_select"
  ON solicitud_candidatos FOR SELECT
  TO public
  USING (
    prestador_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = solicitud_candidatos.solicitud_id AND s.cliente_id = auth.uid()
    )
  );

-- Usado por la RPC postularse_a_solicitud (SECURITY INVOKER, corre con el JWT
-- del prestador que llama a POST /solicitudes/:id/postularse).
CREATE POLICY "solicitud_candidatos_insert_propio"
  ON solicitud_candidatos FOR INSERT
  TO public
  WITH CHECK (prestador_id = auth.uid());

-- Usado por elegirCandidato(): el cliente dueño de la solicitud marca
-- elegido/no_elegido a los candidatos.
CREATE POLICY "solicitud_candidatos_update_cliente"
  ON solicitud_candidatos FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = solicitud_candidatos.solicitud_id AND s.cliente_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = solicitud_candidatos.solicitud_id AND s.cliente_id = auth.uid()
    )
  );

-- ─── evidencias ────────────────────────────────────────────────────────────
ALTER TABLE evidencias ENABLE ROW LEVEL SECURITY;

CREATE POLICY "evidencias_select_involucrados"
  ON evidencias FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = evidencias.trabajo_id
        AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );

CREATE POLICY "evidencias_insert_involucrados"
  ON evidencias FOR INSERT
  TO public
  WITH CHECK (
    subido_por = auth.uid()
    AND EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = evidencias.trabajo_id
        AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );

-- updateStatus() pone expires_at con el JWT del cliente/prestador al finalizar.
CREATE POLICY "evidencias_update_involucrados"
  ON evidencias FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = evidencias.trabajo_id
        AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = evidencias.trabajo_id
        AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );
-- Sin policy de DELETE: el borrado real (EvidenciasCleanupService) corre con
-- service_role.

-- ─── disputas ──────────────────────────────────────────────────────────────
ALTER TABLE disputas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "disputas_select_involucrados"
  ON disputas FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = disputas.trabajo_id
        AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );

CREATE POLICY "disputas_insert_involucrados"
  ON disputas FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = disputas.trabajo_id
        AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );
-- Sin policy de UPDATE: la resolución de disputas (admin.service.ts) corre con
-- service_role.

-- ─── postulaciones ─────────────────────────────────────────────────────────
-- Tabla legacy sin ningún caller en el código actual (confirmado: sin matches
-- de .from('postulaciones') en src/). RLS habilitado sin policies = bloqueada
-- por completo para anon/authenticated; el service_role la sigue viendo si
-- hiciera falta. Candidata a DROP TABLE en una limpieza aparte (deuda técnica,
-- ROADMAP.md sección 4) — no se elimina en esta migración por no mezclar un
-- cambio de seguridad con uno destructivo.
ALTER TABLE postulaciones ENABLE ROW LEVEL SECURITY;
