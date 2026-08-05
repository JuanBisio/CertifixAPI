import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRevocacionDto {
  @ApiPropertyOptional({ example: 'Ya no necesito el servicio' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  motivo?: string;
}
