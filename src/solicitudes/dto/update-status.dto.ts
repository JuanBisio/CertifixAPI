import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateStatusDto {
  @ApiProperty({
    example: 'en_camino',
    enum: ['en_camino', 'finalizado', 'cerrado'],
    description:
      'Transiciones válidas: aceptado→en_camino (prestador), aceptado/en_camino→finalizado (prestador), finalizado→cerrado (cliente)',
  })
  @IsString()
  @IsIn(['en_camino', 'finalizado', 'cerrado'])
  estado: string;
}
