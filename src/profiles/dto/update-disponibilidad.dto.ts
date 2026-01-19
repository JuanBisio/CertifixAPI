import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateDisponibilidadDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  disponible: boolean;
}
