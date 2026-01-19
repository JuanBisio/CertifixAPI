import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePrestadorDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsString()
  rubro_id: string;

  @ApiProperty({ example: 'Palermo, Buenos Aires' })
  @IsString()
  zona_nombre: string;

  @ApiPropertyOptional({ 
    example: { lat: -34.5875, lng: -58.4261 },
    description: 'Geographic coordinates as {lat, lng}'
  })
  @IsOptional()
  @IsObject()
  coordenadas?: { lat: number; lng: number };
}
