import { IsString, IsOptional, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateRubroDto {
  @ApiPropertyOptional({ example: 'Plomería' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  nombre?: string;

  @ApiPropertyOptional({ example: '🔧' })
  @IsOptional()
  @IsString()
  icono?: string;
}
