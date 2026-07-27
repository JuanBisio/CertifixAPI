import { IsBoolean, IsLatitude, IsLongitude, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAddressDto {
  @ApiProperty({ example: 'Casa' })
  @IsString()
  @MaxLength(40)
  alias: string;

  @ApiProperty({ example: 'Av. Santa Fe 2500, Palermo, CABA' })
  @IsString()
  direccion: string;

  @ApiProperty({ example: 'CABA' })
  @IsString()
  zona_nombre: string;

  @ApiProperty({ example: -34.5875 })
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: -58.4261 })
  @IsLongitude()
  lon: number;

  @ApiPropertyOptional({ description: 'Google Place ID, si vino de autocompletado' })
  @IsOptional()
  @IsString()
  place_id?: string;

  @ApiPropertyOptional({ description: 'Marcar como dirección predeterminada' })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
