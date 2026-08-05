import { IsUUID, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDisputaDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID()
  trabajo_id: string;

  @ApiProperty({ example: 'El trabajo no se completó según lo acordado' })
  @IsString()
  razon: string;
}
