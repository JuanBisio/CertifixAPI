import {
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

class CoordenadasDto {
  @ApiProperty({ example: -58.4261 })
  @IsNumber()
  lon: number;

  @ApiProperty({ example: -34.5875 })
  @IsNumber()
  lat: number;
}

// RQ-01: rango horario real (HH:mm) en vez de los 3 bloques fijos mañana/tarde/noche.
const HORA_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

class FranjasHorariasDto {
  @ApiProperty({ example: '09:00', description: 'Hora desde (HH:mm)' })
  @IsString()
  @Matches(HORA_REGEX, { message: 'desde debe tener formato HH:mm' })
  desde: string;

  @ApiProperty({ example: '18:00', description: 'Hora hasta (HH:mm)' })
  @IsString()
  @Matches(HORA_REGEX, { message: 'hasta debe tener formato HH:mm' })
  hasta: string;
}

export class CreatePrestadorDto {
  @ApiProperty({
    example: ['rubro-uuid-1', 'rubro-uuid-2'],
    description: 'IDs de rubros en los que trabaja (mín. 1)',
  })
  @IsArray()
  @IsString({ each: true })
  rubros_ids: string[];

  @ApiProperty({ example: { desde: '09:00', hasta: '18:00' } })
  @IsObject()
  @ValidateNested()
  @Type(() => FranjasHorariasDto)
  franjas_horarias: FranjasHorariasDto;

  @ApiProperty({ example: { lon: -58.4261, lat: -34.5875 } })
  @IsObject()
  @ValidateNested()
  @Type(() => CoordenadasDto)
  coordenadas: CoordenadasDto;

  // PER-06: nombre legible de la zona elegida en el picker (búsqueda por
  // dirección o "usar mi ubicación actual") — puramente informativo, no se usa
  // para el matching (eso es ST_DWithin sobre `coordenadas`).
  @ApiPropertyOptional({ example: 'Córdoba Capital' })
  @IsOptional()
  @IsString()
  zona_nombre?: string;
}
