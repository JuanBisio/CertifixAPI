import { IsOptional, IsIn, IsString, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';

const ESTADOS = [
  'buscando',
  'aceptado',
  'en_camino',
  'en_trabajo',
  'finalizado',
  'cerrado',
  'cancelado',
] as const;

export class ListSolicitudesQuery extends PaginationDto {
  @IsOptional()
  @IsIn(ESTADOS)
  @ApiPropertyOptional({ enum: ESTADOS })
  estado?: string;

  @IsOptional()
  @IsString() // rubro_id es TEXT, no UUID
  @ApiPropertyOptional()
  rubro_id?: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional()
  desde?: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional()
  hasta?: string;
}
