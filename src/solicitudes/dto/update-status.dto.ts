import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateStatusDto {
  @ApiProperty({
    example: 'en_camino',
    enum: ['en_camino', 'en_trabajo', 'finalizado', 'cerrado'],
    description:
      'Transiciones válidas: aceptado→en_camino (prestador), en_camino→en_trabajo (prestador), ' +
      'aceptado/en_camino/en_trabajo→finalizado (prestador), finalizado→cerrado (cliente)',
  })
  @IsString()
  @IsIn(['en_camino', 'en_trabajo', 'finalizado', 'cerrado'])
  estado: string;
}
