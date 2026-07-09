import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendOtpDto {
  @ApiProperty({ example: '+5491150001234', description: 'Número de teléfono en formato E.164' })
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'El teléfono debe estar en formato E.164 (ej: +5491150001234)' })
  phone: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+5491150001234' })
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'El teléfono debe estar en formato E.164' })
  phone: string;

  @ApiProperty({ example: '123456', description: 'Código OTP recibido por SMS' })
  @IsString()
  token: string;
}
