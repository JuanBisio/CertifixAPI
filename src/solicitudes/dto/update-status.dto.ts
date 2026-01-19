import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateStatusDto {
  @ApiProperty({ 
    example: 'pagado', 
    enum: ['pendiente', 'aceptado', 'pagado', 'finalizado', 'cerrado'],
    description: 'New status for the work request'
  })
  @IsString()
  @IsIn(['pendiente', 'aceptado', 'pagado', 'finalizado', 'cerrado'])
  estado: string;
}