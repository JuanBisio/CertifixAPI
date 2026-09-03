// Sniffing de magic bytes para validar el contenido real de un archivo
// subido, en vez de confiar únicamente en `file.mimetype` (header
// multipart declarado por el cliente, trivialmente falseable) — ver
// hallazgo de seguridad F6.

const SIGNATURES: Record<string, { bytes: number[]; offset?: number }[]> = {
  'image/jpeg': [{ bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [
    { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  ],
  'application/pdf': [{ bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
};

function matchesSignature(buffer: Buffer, mimetype: string): boolean {
  const candidates = SIGNATURES[mimetype];
  if (!candidates) return false;
  return candidates.some(({ bytes, offset = 0 }) => {
    if (buffer.length < offset + bytes.length) return false;
    return bytes.every((b, i) => buffer[offset + i] === b);
  });
}

/**
 * Verifica que el contenido real del archivo (magic bytes) coincida con
 * alguno de los mimetypes declarados como permitidos. No reemplaza el
 * chequeo de `file.mimetype` contra el allowlist — es una segunda barrera
 * sobre el contenido real, para que un archivo no-imagen etiquetado
 * `image/jpeg` no pase la validación.
 */
export function isFileContentAllowed(
  buffer: Buffer,
  allowedMimetypes: Iterable<string>,
): boolean {
  for (const mimetype of allowedMimetypes) {
    if (matchesSignature(buffer, mimetype)) return true;
  }
  return false;
}
