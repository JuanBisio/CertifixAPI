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
}
