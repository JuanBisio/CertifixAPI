import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { User } from '@supabase/supabase-js';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser, AccessToken } from '../common/decorators/current-user.decorator';

@ApiTags('Addresses')
@Controller('addresses')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class AddressesController {
  constructor(private addressesService: AddressesService) {}

  @Post()
  @ApiOperation({ summary: 'Guardar una nueva dirección del cliente' })
  create(@CurrentUser() user: User, @AccessToken() accessToken: string, @Body() dto: CreateAddressDto) {
    return this.addressesService.create(user.id, dto, accessToken);
  }

  @Get()
  @ApiOperation({ summary: 'Listar direcciones guardadas del cliente autenticado' })
  findAll(@CurrentUser() user: User, @AccessToken() accessToken: string) {
    return this.addressesService.findAll(user.id, accessToken);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar una dirección guardada' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addressesService.update(id, user.id, dto, accessToken);
  }

  @Patch(':id/default')
  @ApiOperation({ summary: 'Marcar una dirección como predeterminada' })
  setDefault(@Param('id') id: string, @CurrentUser() user: User, @AccessToken() accessToken: string) {
    return this.addressesService.setDefault(id, user.id, accessToken);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar (soft delete) una dirección guardada' })
  remove(@Param('id') id: string, @CurrentUser() user: User, @AccessToken() accessToken: string) {
    return this.addressesService.remove(id, user.id, accessToken);
  }
}
