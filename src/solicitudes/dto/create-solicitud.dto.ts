import {
  IsString,
  IsDateString,
  IsOptional,
  IsArray,
  IsIn,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TipoTecnico {
  ESTANDAR = 'estandar',
  PREMIUM = 'premium',
}

export enum Urgencia {
  AHORA = 'ahora',
  PROGRAMADO = 'programado',
}

export enum FranjaHoraria {
  MANANA = 'manana',
  TARDE = 'tarde',
  NOCHE = 'noche',
}

export class CreateSolicitudDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsString()
  rubro_id: string;

  @ApiProperty({ example: 'Cañería rota en la cocina, hay fuga importante' })
  @IsString()
  descripcion: string;

  @ApiPropertyOptional({
    example: ['https://storage.supabase.co/...jpg'],
    description: 'URLs de fotos/videos subidas previamente al storage',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fotos_urls?: string[];

  @ApiProperty({ enum: TipoTecnico, default: TipoTecnico.ESTANDAR })
  @IsEnum(TipoTecnico)
  tipo_tecnico: TipoTecnico;

  @ApiProperty({ enum: Urgencia, default: Urgencia.AHORA })
  @IsEnum(Urgencia)
  urgencia: Urgencia;

  @ApiPropertyOptional({
    enum: FranjaHoraria,
    description: 'Requerido si urgencia = programado',
  })
  @IsOptional()
  @IsEnum(FranjaHoraria)
  franja_horaria?: FranjaHoraria;

  @ApiPropertyOptional({
    example: '2026-05-10',
    description: 'Fecha preferida ISO (requerida si urgencia = programado)',
  })
  @IsOptional()
  @IsDateString()
  fecha_preferida?: string;

  @ApiProperty({ example: 'Av. Santa Fe 2500, Palermo, CABA' })
  @IsString()
  direccion_exacta: string;

  @ApiProperty({ example: 'Palermo' })
  @IsString()
  zona_nombre: string;

  @ApiProperty({ example: '-58.3816,-34.6037', description: 'lon,lat exactas (privadas)' })
  @IsString()
  coordenadas_privadas: string;

  @ApiPropertyOptional({ example: '-58.38,-34.60', description: 'lon,lat aproximadas (~500m offset)' })
  @IsOptional()
  @IsString()
  coordenadas_publicas?: string;
}
