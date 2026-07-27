import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRatingDto {
  @ApiProperty({ example: 'uuid-de-la-solicitud' })
  @IsUUID()
  solicitud_id: string;

  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  puntaje: number;

  @ApiPropertyOptional({ example: 'Muy buen trabajo, llegó rápido' })
  @IsOptional()
  @IsString()
  comentario?: string;

  // CAL-02: subcategorías opcionales — solo aplican a la calificación del cliente hacia el prestador
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Opcional' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  comunicacion?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Opcional' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  puntualidad?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Opcional' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  atencion?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Opcional' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  eficiencia?: number;
}
