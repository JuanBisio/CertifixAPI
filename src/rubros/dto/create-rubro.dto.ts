import { IsString, IsOptional, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRubroDto {
  @ApiProperty({ example: 'Plomería' })
  @IsString()
  @MinLength(2)
  nombre: string;

  @ApiPropertyOptional({ example: '🔧' })
  @IsOptional()
  @IsString()
  icono?: string;
}
