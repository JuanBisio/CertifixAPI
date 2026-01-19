import { IsUUID, IsBoolean, IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateEvidenciaDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID()
  trabajo_id: string;

  @ApiProperty({ example: false, description: 'Is this evidence for a dispute/claim?' })
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  es_reclamo: boolean;

  @ApiPropertyOptional({ example: 'Trabajo completado según lo acordado' })
  @IsOptional()
  @IsString()
  comentario?: string;
}