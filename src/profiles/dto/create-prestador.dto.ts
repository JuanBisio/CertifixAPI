import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
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

class FranjasHorariasDto {
  @ApiProperty({ example: false })
  manana: boolean;

  @ApiProperty({ example: true })
  tarde: boolean;

  @ApiProperty({ example: false })
  noche: boolean;
}

export class CreatePrestadorDto {
  @ApiProperty({
    example: ['rubro-uuid-1', 'rubro-uuid-2'],
    description: 'IDs de rubros en los que trabaja (mín. 1)',
  })
  @IsArray()
  @IsString({ each: true })
  rubros_ids: string[];

  @ApiProperty({ example: 10, description: 'Radio de cobertura en km (2–20)' })
  @IsInt()
  @Min(2)
  @Max(20)
  radio_km: number;

  @ApiProperty({ example: { manana: false, tarde: true, noche: false } })
  @IsObject()
  franjas_horarias: FranjasHorariasDto;

  @ApiPropertyOptional({ example: { lon: -58.4261, lat: -34.5875 } })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CoordenadasDto)
  coordenadas?: CoordenadasDto;

  @ApiPropertyOptional({ example: 'Palermo, CABA' })
  @IsOptional()
  @IsString()
  zona_nombre?: string;
}
