-- Habilita RLS en las 8 tablas que hoy están completamente expuestas a
-- anon/authenticated (hallazgo de get_advisors). Las políticas replican
-- exactamente los chequeos de autorización que el backend NestJS ya hace en
-- TypeScript (SupabaseService.getAuthenticatedClient respeta RLS; getServiceClient
-- la bypasea siempre) — no son reglas nuevas, son el mismo control de acceso
-- expresado también a nivel de base de datos como defensa en profundidad.
--
-- Prerequisito ya aplicado en código: admin.service.ts pasó de
-- getAuthenticatedClient(accessToken) a getServiceClient(), porque el chequeo
-- de "es admin" vive en AdminGuard (app_metadata/allowlist de env), no en una
-- columna de la base — no es replicable en una policy SQL.

-- ─── rubros: tabla de referencia pública, sin datos sensibles ───────────────
-- GET /rubros no tiene guard (endpoint público, corre con el cliente anon).

ALTER TABLE public.rubros ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rubros_select_public" ON public.rubros FOR SELECT
TO anon, authenticated
USING (true);

-- ─── perfiles ────────────────────────────────────────────────────────────────
-- SELECT amplio para cualquier usuario logueado: GET /profiles/:id (perfil
-- público) y los embeds de nombre/teléfono en solicitudes_trabajo/calificaciones
-- ya exponen esto hoy sin restricción de relación previa — no es un cambio de
-- comportamiento, solo se exige estar autenticado (hoy ni eso hace falta).

ALTER TABLE public.perfiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "perfiles_select_authenticated" ON public.perfiles FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "perfiles_insert_own" ON public.perfiles FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = id);

CREATE POLICY "perfiles_update_own" ON public.perfiles FOR UPDATE
TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- ─── perfiles_prestadores ────────────────────────────────────────────────────
-- Mismo criterio: SELECT amplio (getPublicProfile, get_prestadores_para_solicitud
-- corriendo como el cliente que crea la solicitud, notifyPrestadoresFallback
-- leyendo flags de N prestadores) — todos ya son lecturas cross-user hoy.

ALTER TABLE public.perfiles_prestadores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "perfiles_prestadores_select_authenticated" ON public.perfiles_prestadores FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "perfiles_prestadores_insert_own" ON public.perfiles_prestadores FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = id);

CREATE POLICY "perfiles_prestadores_update_own" ON public.perfiles_prestadores FOR UPDATE
TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- ─── solicitudes_trabajo ─────────────────────────────────────────────────────
-- La más delicada: accept() y postularse_a_solicitud() actualizan una fila
-- ANTES de ser dueños de ella (estado='buscando', prestador_id IS NULL) — una
-- policy de ownership puro rompería "aceptar trabajo" y "postularse" apenas
-- se habilite RLS.

ALTER TABLE public.solicitudes_trabajo ENABLE ROW LEVEL SECURITY;

CREATE POLICY "solicitudes_trabajo_select" ON public.solicitudes_trabajo FOR SELECT
TO authenticated
USING (
  cliente_id = auth.uid()
  OR prestador_id = auth.uid()
  OR (
    -- prestador "visitante": ve solicitudes buscando que matchean su rubro
    -- (mismo filtro que findAll() aplica en TS)
    estado = 'buscando'
    AND EXISTS (SELECT 1 FROM perfiles_prestadores pp WHERE pp.id = auth.uid() AND pp.esta_verificado = true)
    AND EXISTS (SELECT 1 FROM prestador_rubros pr WHERE pr.prestador_id = auth.uid() AND pr.rubro_id = solicitudes_trabajo.rubro_id)
  )
  OR EXISTS (
    -- candidato programado: sigue viendo el detalle aunque no lo elijan o
    -- el estado ya no sea buscando (mismo criterio que isPrestadorVisitante en findOne())
    SELECT 1 FROM solicitud_candidatos sc
    WHERE sc.solicitud_id = solicitudes_trabajo.id AND sc.prestador_id = auth.uid()
  )
);

CREATE POLICY "solicitudes_trabajo_insert" ON public.solicitudes_trabajo FOR INSERT
TO authenticated
WITH CHECK (cliente_id = auth.uid());

CREATE POLICY "solicitudes_trabajo_update" ON public.solicitudes_trabajo FOR UPDATE
TO authenticated
USING (
  cliente_id = auth.uid()
  OR prestador_id = auth.uid()
  OR (
    -- accept()/postularse_a_solicitud(): prestador verificado tomando/postulándose
    -- a una fila todavía sin asignar
    estado = 'buscando' AND prestador_id IS NULL
    AND EXISTS (SELECT 1 FROM perfiles_prestadores pp WHERE pp.id = auth.uid() AND pp.esta_verificado = true)
    AND EXISTS (SELECT 1 FROM prestador_rubros pr WHERE pr.prestador_id = auth.uid() AND pr.rubro_id = solicitudes_trabajo.rubro_id)
  )
)
WITH CHECK (
  cliente_id = auth.uid()
  OR prestador_id = auth.uid()
  OR (
    -- postularse_a_solicitud() no cambia prestador_id (solo candidatos_count),
    -- así que el resultado post-update sigue sin ser "dueño" — se re-valida
    -- el mismo match de verificado+rubro
    EXISTS (SELECT 1 FROM perfiles_prestadores pp WHERE pp.id = auth.uid() AND pp.esta_verificado = true)
    AND EXISTS (SELECT 1 FROM prestador_rubros pr WHERE pr.prestador_id = auth.uid() AND pr.rubro_id = solicitudes_trabajo.rubro_id)
  )
);

-- ─── solicitud_candidatos ────────────────────────────────────────────────────
-- Se había creado sin RLS (acceso solo vía backend); se protege ahora por
-- consistencia con el resto — un candidato nunca debe poder leer la fila de otro.

ALTER TABLE public.solicitud_candidatos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "solicitud_candidatos_select" ON public.solicitud_candidatos FOR SELECT
TO authenticated
USING (
  prestador_id = auth.uid()
  OR EXISTS (SELECT 1 FROM solicitudes_trabajo st WHERE st.id = solicitud_candidatos.solicitud_id AND st.cliente_id = auth.uid())
);

CREATE POLICY "solicitud_candidatos_insert" ON public.solicitud_candidatos FOR INSERT
TO authenticated
WITH CHECK (prestador_id = auth.uid());

CREATE POLICY "solicitud_candidatos_update" ON public.solicitud_candidatos FOR UPDATE
TO authenticated
USING (EXISTS (SELECT 1 FROM solicitudes_trabajo st WHERE st.id = solicitud_candidatos.solicitud_id AND st.cliente_id = auth.uid()))
WITH CHECK (EXISTS (SELECT 1 FROM solicitudes_trabajo st WHERE st.id = solicitud_candidatos.solicitud_id AND st.cliente_id = auth.uid()));

-- ─── evidencias ──────────────────────────────────────────────────────────────
-- Sin columna de dueño propia (salvo subido_por, que el código no usa para
-- filtrar SELECT — ambas partes ven todo). Pertenencia vía JOIN a solicitudes_trabajo.

ALTER TABLE public.evidencias ENABLE ROW LEVEL SECURITY;

CREATE POLICY "evidencias_select" ON public.evidencias FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM solicitudes_trabajo st
    WHERE st.id = evidencias.trabajo_id
      AND (st.cliente_id = auth.uid() OR st.prestador_id = auth.uid())
  )
);

CREATE POLICY "evidencias_insert" ON public.evidencias FOR INSERT
TO authenticated
WITH CHECK (
  subido_por = auth.uid()
  AND EXISTS (
    SELECT 1 FROM solicitudes_trabajo st
    WHERE st.id = evidencias.trabajo_id
      AND (st.cliente_id = auth.uid() OR st.prestador_id = auth.uid())
  )
);

CREATE POLICY "evidencias_update" ON public.evidencias FOR UPDATE
TO authenticated
USING (
  -- updateStatus() al marcar 'finalizado' actualiza expires_at de evidencias
  -- que puede haber subido la contraparte, no solo las propias
  EXISTS (
    SELECT 1 FROM solicitudes_trabajo st
    WHERE st.id = evidencias.trabajo_id
      AND (st.cliente_id = auth.uid() OR st.prestador_id = auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM solicitudes_trabajo st
    WHERE st.id = evidencias.trabajo_id
      AND (st.cliente_id = auth.uid() OR st.prestador_id = auth.uid())
  )
);

-- ─── disputas ────────────────────────────────────────────────────────────────
-- Sin columna de dueño (ni siquiera "creado_por") — pertenencia 100% vía JOIN.
-- Sin policy UPDATE para authenticated: solo el admin resuelve disputas, y
-- admin.service.ts ya usa service_role (bypasea RLS).

ALTER TABLE public.disputas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "disputas_select" ON public.disputas FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM solicitudes_trabajo st
    WHERE st.id = disputas.trabajo_id
      AND (st.cliente_id = auth.uid() OR st.prestador_id = auth.uid())
  )
);

CREATE POLICY "disputas_insert" ON public.disputas FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM solicitudes_trabajo st
    WHERE st.id = disputas.trabajo_id
      AND (st.cliente_id = auth.uid() OR st.prestador_id = auth.uid())
  )
);

-- ─── postulaciones (legacy, sin código que la use) ──────────────────────────
-- Deny-all: se habilita RLS sin ninguna policy en vez de diseñar reglas de
-- negocio ficticias para una tabla sin caller real. Candidata a DROP en la
-- limpieza de deuda técnica (ver ROADMAP sección 4) — se deja accesible solo
-- por service_role hasta esa decisión.

ALTER TABLE public.postulaciones ENABLE ROW LEVEL SECURITY;
