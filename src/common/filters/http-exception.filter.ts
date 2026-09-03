import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object') {
        message = (exceptionResponse as any).message || exception.message;
        errors = (exceptionResponse as any).errors;
      } else {
        message = exceptionResponse;
      }
    }

    // Para excepciones no controladas (no-HttpException) no se devuelve
    // exception.message al cliente — puede contener detalle interno (mensajes
    // del driver de Postgres/Supabase, fragmentos de SQL, nombres de columna).
    // Se loguea completo server-side; el cliente recibe el mensaje genérico.
    const logMessage =
      exception instanceof Error ? exception.message : message;
    this.logger.error(
      `${request.method} ${request.url} - Status: ${status} - Message: ${logMessage}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    const errorResponse: any = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    };

    if (errors) {
      errorResponse.errors = errors;
    }

    response.status(status).json(errorResponse);
  }
}
