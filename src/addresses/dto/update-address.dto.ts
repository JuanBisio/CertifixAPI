import { IsBoolean, IsLatitude, IsLongitude, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAddressDto {
  @ApiPropertyOptional({ example: 'Casa' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  alias?: string;

  @ApiPropertyOptional({ example: 'Av. Santa Fe 2500, Palermo, CABA' })
  @IsOptional()
  @IsString()
  direccion?: string;

  @ApiPropertyOptional({ example: 'CABA' })
  @IsOptional()
  @IsString()
  zona_nombre?: string;

  @ApiPropertyOptional({ example: -34.5875 })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: -58.4261 })
  @IsOptional()
  @IsLongitude()
  lon?: number;

  @ApiPropertyOptional({ description: 'Google Place ID, si vino de autocompletado' })
  @IsOptional()
  @IsString()
  place_id?: string;

  @ApiPropertyOptional({ description: 'Marcar como dirección predeterminada' })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
