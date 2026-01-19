import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Swagger configuration
  const swaggerPath = 'api-docs';
  const config = new DocumentBuilder()
    .setTitle('CertiFix API')
    .setDescription(
      'REST API for CertiFix platform - connecting certified service providers with clients',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter your Supabase JWT token',
      },
      'bearer',
    )
    .addServer('http://localhost:3000', 'Local Development')
    .addTag('Authentication', 'User authentication endpoints')
    .addTag('Profiles', 'User profile management')
    .addTag('Rubros', 'Service categories')
    .addTag('Solicitudes (Work Requests)', 'Work request management')
    .addTag('Evidencias (Evidence)', 'Evidence file uploads')
    .addTag('Disputas (Disputes)', 'Dispute management')
    .addTag('Notifications', 'Push notification management')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // Add cache prevention middleware for Swagger
  app.use(
    `/${swaggerPath}`,
    (req: Request, res: Response, next: NextFunction) => {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate',
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
      next();
    },
  );

  SwaggerModule.setup(swaggerPath, app, document, {
    customSiteTitle: 'CertiFix API',
    customfavIcon: 'https://cdn-icons-png.flaticon.com/512/3281/3281307.png',
    customCss: `
      .swagger-ui .topbar { display: none; }
      .swagger-ui .info .title { font-size: 2.5rem; color: #1a202c; }
      .swagger-ui .info .description { font-size: 1rem; color: #4a5568; line-height: 1.6; }
      .swagger-ui { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; }
      .swagger-ui .scheme-container { background: #f7fafc; border: 1px solid #e2e8f0; padding: 1rem; border-radius: 8px; }
      .swagger-ui .opblock { border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 1rem; }
      .swagger-ui .opblock .opblock-summary { padding: 1rem; }
      .swagger-ui .opblock.opblock-post { border-color: #48bb78; }
      .swagger-ui .opblock.opblock-get { border-color: #4299e1; }
      .swagger-ui .opblock.opblock-put { border-color: #ed8936; }
      .swagger-ui .opblock.opblock-delete { border-color: #f56565; }
      .swagger-ui .btn.authorize { background-color: #4299e1; border-color: #4299e1; }
      .swagger-ui .btn.authorize:hover { background-color: #3182ce; }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
      displayRequestDuration: true,
    },
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`\n✅ CertiFix Backend Service Started`);
  logger.log(`🚀 Server running on: http://localhost:${port}`);
  logger.log(`📚 API Documentation: http://localhost:${port}/${swaggerPath}`);
  logger.log(`\n🛠️  Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.log(`📊 Database: Supabase (${process.env.SUPABASE_URL})\n`);
}

bootstrap();