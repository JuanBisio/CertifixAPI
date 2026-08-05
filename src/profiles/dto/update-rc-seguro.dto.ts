import { IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateRcSeguroDto {
  @ApiPropertyOptional({ example: 'La Caja Seguros' })
  @IsOptional()
  @IsString()
  aseguradora?: string;

  @ApiPropertyOptional({ example: 'RC-123456' })
  @IsOptional()
  @IsString()
  numero_poliza?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'Fecha de vencimiento de la póliza (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  vencimiento?: string;
}
