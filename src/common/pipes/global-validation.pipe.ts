import { ValidationPipe } from '@nestjs/common';

// Config única del ValidationPipe global. Vive acá (y no inline en main.ts)
// para que los specs que necesitan reproducir el pipeline HTTP real usen
// exactamente la misma configuración que producción.
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
  });
}
