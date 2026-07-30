import { IsNumber, IsOptional, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PostularseDto {
  @ApiPropertyOptional({
    example: 15000,
    description:
      'Presupuesto estimado, visible para el cliente al comparar candidatos. No es vinculante: el precio final se sigue acordando por chat.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  presupuesto?: number;
}
