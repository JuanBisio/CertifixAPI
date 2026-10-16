/**
 * SOL-04 — Radio de matching adaptativo.
 *
 * El matching arranca en el radio más chico y lo amplía en rondas si nadie
 * acepta / se postula. Reemplaza el uso directo de `perfiles_prestadores.
 * radio_km` como único criterio de alcance (ver ROADMAP.md sección 3.13).
 *
 * Decisiones de producto (confirmadas con el usuario, 2026-09-06):
 *
 * 1. Escalera: 10 → 20 → 40 → 80 km. Arranca en 10 km, que es el default
 *    histórico de `radio_km` (v1_sprint1_schema.sql:40) y el valor de 6 de los
 *    8 prestadores reales — así la ronda 1 no achica el alcance respecto del
 *    comportamiento anterior.
 *
 * 2. El radio de la ronda NO pisa el `radio_km` declarado por el prestador,
 *    salvo en la ÚLTIMA ronda ("rescate"): rondas 1..N-1 usan
 *    min(radio_ronda, pp.radio_km), la ronda N usa el radio de la ronda a
 *    secas. Un prestador que dijo "cubro 10 km" solo recibe un trabajo a 60 km
 *    cuando ya no queda nadie más, y con copy explícito en el push.
 *
 * 3. Aplica a los dos modos (urgente y programado), con cadencias distintas.
 *
 * 4. La ronda avanza SOLO si la ronda actual quedó vacía (0 prestadores
 *    notificados). Si notificó a alguien, espera el intervalo largo antes de
 *    ampliar, para no salirle a buscar competencia al prestador cercano
 *    mientras decide.
 */

// Radio de cada ronda, en km. El índice 0 es la ronda 1.
export const RONDAS_RADIO_KM = [10, 20, 40, 80];

export const ULTIMA_RONDA = RONDAS_RADIO_KM.length;

/**
 * Minutos que hay que esperar antes de ampliar a la ronda siguiente.
 *
 * `vacia`: la ronda actual no notificó a nadie — no tiene sentido esperar, se
 * amplía en el próximo tick del cron (que corre cada 2 min: ese es el piso
 * real de granularidad, pedir menos no cambia nada).
 *
 * `conNotificados`: la ronda notificó a ≥1 prestador — se le da tiempo a
 * responder antes de ampliar. En urgente son 2 ticks del cron; en programado
 * el plazo total es de 120 min (POSTULACION_DEADLINE_MINUTES), así que 20 min
 * por ronda deja la escalera completa al minuto 60 en el peor caso.
 */
export const INTERVALO_RONDA_MINUTOS = {
  ahora: { vacia: 2, conNotificados: 4 },
  programado: { vacia: 2, conNotificados: 20 },
} as const;

export type UrgenciaSolicitud = keyof typeof INTERVALO_RONDA_MINUTOS;

/** Radio (km) que le corresponde a una ronda. Fuera de rango → última ronda. */
export function radioDeRonda(ronda: number): number {
  const idx = Math.min(Math.max(ronda, 1), ULTIMA_RONDA) - 1;
  return RONDAS_RADIO_KM[idx];
}

/** Solo la última ronda ignora el `radio_km` declarado por el prestador. */
export function esRondaDeRescate(ronda: number): boolean {
  return ronda >= ULTIMA_RONDA;
}

/**
 * Radio efectivo para UN prestador en una ronda dada. Es el mismo criterio que
 * aplica el RPC `get_prestadores_para_solicitud` en SQL — se replica acá para
 * el filtro Haversine de `SolicitudesService.findAll()` y para el fallback de
 * `NotificationsService`, que no pueden llamar a PostGIS. Si los tres quedan
 * desalineados vuelve a pasar lo de la sección 3.12 del ROADMAP.
 */
export function radioEfectivoKm(
  ronda: number,
  radioPrestadorKm: number | null,
) {
  const radioRonda = radioDeRonda(ronda);
  if (esRondaDeRescate(ronda)) return radioRonda;
  return Math.min(radioRonda, radioPrestadorKm ?? 10);
}

/** Minutos a esperar antes de pasar de `ronda` a `ronda + 1`. */
export function minutosHastaProximaRonda(
  urgencia: string,
  notificadosEnRondaActual: number,
): number {
  const intervalos =
    INTERVALO_RONDA_MINUTOS[urgencia as UrgenciaSolicitud] ??
    INTERVALO_RONDA_MINUTOS.ahora;
  return notificadosEnRondaActual > 0
    ? intervalos.conNotificados
    : intervalos.vacia;
}

/**
 * Copy del push de una ronda. Vive acá (y no en cada caller) para que la
 * ronda 1 que dispara `create()` y las rondas siguientes que dispara el cron
 * digan exactamente lo mismo — salvo la ronda de rescate, que sí avisa que el
 * trabajo cae fuera de la zona declarada por el prestador.
 */
export function construirPayloadRonda(args: {
  esProgramado: boolean;
  descripcion: string;
  solicitudId: string;
  rubroId: string;
  estado: string;
  ronda: number;
}) {
  const { esProgramado, descripcion, solicitudId, rubroId, estado, ronda } =
    args;
  const data = { solicitudId, rubroId, estado };

  if (esRondaDeRescate(ronda)) {
    return {
      title: esProgramado
        ? 'Trabajo programado fuera de tu zona'
        : 'Trabajo fuera de tu zona',
      body:
        `Está más lejos de tu radio habitual y nadie lo tomó todavía: ` +
        descripcion.substring(0, 80),
      data,
    };
  }

  return esProgramado
    ? {
        title: 'Nuevo trabajo programado',
        body: `Postulate y coordiná el precio por chat: ${descripcion.substring(0, 90)}`,
        data,
      }
    : {
        title: 'Nuevo trabajo disponible',
        body: descripcion.substring(0, 120),
        data,
      };
}

/** Ronda en la que arranca toda solicitud recién creada. */
export const PRIMERA_RONDA = 1;
