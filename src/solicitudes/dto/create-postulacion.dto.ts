import { IsUUID, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePostulacionDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID()
  trabajo_id: string;

  @ApiProperty({ example: 15000 })
  @IsNumber()
  @Min(0)
  monto_ofertado: number;

  @ApiPropertyOptional({ example: 'Puedo ir el martes a la tarde.' })
  @IsOptional()
  @IsString()
  comentario?: string;
}
