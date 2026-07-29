-- Endurece el storage de documentos de verificación de identidad de prestadores
-- (DNI frente/dorso, selfie con DNI, matrícula). Hasta ahora se guardaban con
-- getPublicUrl() (URL pública permanente) — cualquiera con el link accedía sin
-- autenticación. Se alinea con el patrón ya usado en el bucket `evidencias`:
-- bucket privado + signed URLs generadas server-side con el service client.
--
-- ⚠️ PASO PREVIO OBLIGATORIO (ejecutar antes de lo de abajo, manualmente):
-- los buckets `documentos-prestadores` y `fotos-perfil` se crearon fuera de
-- banda (no hay rastro en este repo), así que pueden existir policies viejas
-- sobre storage.objects para estos buckets. En Postgres las RLS policies se
-- combinan con OR, así que una policy vieja permisiva seguiría abriendo el
-- acceso aunque agreguemos las nuevas restrictivas de abajo. Correr primero:
--
--   select policyname, cmd, roles, qual, with_check
--   from pg_policies
--   where schemaname = 'storage' and tablename = 'objects'
--     and (qual::text ilike '%documentos-prestadores%' or qual::text ilike '%fotos-perfil%'
--          or with_check::text ilike '%documentos-prestadores%' or with_check::text ilike '%fotos-perfil%');
--
-- y borrar con `DROP POLICY IF EXISTS "<nombre>" ON storage.objects;` cualquier
-- policy encontrada que no sea una de las que se crean acá.

-- ─── documentos-prestadores: bucket PRIVADO ────────────────────────────────
-- DNI frente/dorso, selfie con DNI y matrícula — datos sensibles (Ley 25.326).
-- Las signed URLs se generan siempre server-side con el service client (ver
-- ProfilesService.getSignedUrlForDocumento), nunca se expone una URL pública.
insert into storage.buckets (id, name, public)
values ('documentos-prestadores', 'documentos-prestadores', false)
on conflict (id) do update set public = false;

alter table storage.objects enable row level security; -- idempotente

-- INSERT/UPDATE restringidos al propio usuario, por prefijo de carpeta. El
-- fileName sigue el patrón ${userId}/${tipo}_${timestamp}_${nombre} (ver
-- ProfilesService.uploadDocumento), así (storage.foldername(name))[1]
-- coincide con auth.uid().
create policy "documentos_prestadores_insert_propio"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documentos-prestadores'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "documentos_prestadores_update_propio"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'documentos-prestadores'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'documentos-prestadores'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Sin policy de SELECT/DELETE para authenticated/anon: a propósito. Las
-- lecturas (signed URLs) y los borrados (cron de limpieza) sólo pasan por el
-- service client, que bypassea RLS. Esto mitiga el gap ya documentado en
-- docs/ROADMAP.md (perfiles_prestadores con SELECT amplio a nivel de fila
-- para cualquier autenticado): la columna ahora guarda un path de storage,
-- no una URL utilizable directamente sin el service client.

-- ─── fotos-perfil: bucket PÚBLICO (sin cambio de comportamiento) ──────────
-- Foto de perfil profesional, no es un documento de identidad sensible: ya
-- se expone hoy sin autenticación vía getPublicProfile(). Mantenerla pública
-- evita reescribir ese endpoint y su contrato con el mobile.
insert into storage.buckets (id, name, public)
values ('fotos-perfil', 'fotos-perfil', true)
on conflict (id) do update set public = true;

create policy "fotos_perfil_insert_propio"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'fotos-perfil'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "fotos_perfil_update_propio"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'fotos-perfil'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'fotos-perfil'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
