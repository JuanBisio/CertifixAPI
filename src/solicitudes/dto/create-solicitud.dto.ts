import { IsString, IsDateString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSolicitudDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsString()
  rubro_id: string;

  @ApiProperty({ example: 'Necesito reparar una cañería rota en la cocina' })
  @IsString()
  descripcion: string;

  @ApiProperty({ example: 'Palermo, Buenos Aires, Calle Falsa 123' })
  @IsString()
  direccion_exacta: string;

  @ApiProperty({ example: 'Palermo' })
  @IsString()
  zona_nombre: string;

  @ApiProperty({ example: '-58.3816,-34.6037', description: 'Lat,Lng exact coordinates' })
  @IsString()
  coordenadas_privadas: string;

  @ApiPropertyOptional({ example: '-58.38,-34.60', description: 'Lat,Lng públicas (difusas)' })
  @IsOptional()
  @IsString()
  coordenadas_publicas?: string;

  @ApiProperty({ example: '2026-01-20', description: 'Fecha desde (ISO date)' })
  @IsDateString()
  fecha_desde: string;

  @ApiProperty({ example: '2026-01-22', description: 'Fecha hasta (ISO date)' })
  @IsDateString()
  fecha_hasta: string;
}
