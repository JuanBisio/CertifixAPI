import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ example: 'contraseñaActual123' })
  @IsString()
  current_password: string;

  @ApiProperty({ example: 'contraseñaNueva456' })
  @IsString()
  @MinLength(6)
  new_password: string;
}
