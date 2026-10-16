/**
 * Helpers geográficos compartidos.
 *
 * Existían tres copias de esto (SolicitudesService, NotificationsService y, con
 * SOL-04, el motor de rondas): el criterio de distancia tiene que ser idéntico
 * en el push, en el fallback del push y en la lista "Solicitudes disponibles" —
 * si se desalinean vuelve a pasar lo de la sección 3.12 del ROADMAP.
 */

/**
 * Supabase devuelve las columnas geometry como GeoJSON
 * ({ coordinates: [lon, lat] }) o como WKT ("POINT(lon lat)") según el
 * cliente/columna; soportamos ambos.
 */
export function parsePoint(raw: unknown): { lon: number; lat: number } | null {
  if (!raw) return null;
  if (typeof raw === 'object' && Array.isArray((raw as any).coordinates)) {
    const [lon, lat] = (raw as any).coordinates;
    return typeof lon === 'number' && typeof lat === 'number'
      ? { lon, lat }
      : null;
  }
  if (typeof raw === 'string') {
    const match = raw.match(
      /POINT\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i,
    );
    if (match) return { lon: Number(match[1]), lat: Number(match[2]) };
  }
  return null;
}

/** Distancia en km entre dos puntos lon/lat (fórmula de Haversine). */
export function distanciaKm(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
) {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
