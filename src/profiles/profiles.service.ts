import { 
  Injectable, 
  Logger, 
  BadRequestException, 
  ForbiddenException,
  NotFoundException 
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreatePrestadorDto } from './dto/create-prestador.dto';
import { UpdateDisponibilidadDto } from './dto/update-disponibilidad.dto';

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(private supabaseService: SupabaseService) {}

  mapPrestadorProfile(prestador: any) {
    if (!prestador) return undefined;
    const { esta_verificado, url_certificacion, ...rest } = prestador;
    return {
      ...rest,
      verificado: esta_verificado,
      certificacion_url: url_certificacion,
    };
  }

  async updateProfile(
    profileId: string,
    currentUserId: string,
    updateProfileDto: UpdateProfileDto,
    accessToken: string,
  ) {
    // Ensure user can only update their own profile
    if (profileId !== currentUserId) {
      throw new ForbiddenException('You can only update your own profile');
    }

    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      const { data, error } = await supabase
        .from('perfiles')
        .update(updateProfileDto)
        .eq('id', profileId)
        .select()
        .single();

      if (error) {
        this.logger.error(`Profile update failed: ${error.message}`);
        throw new BadRequestException('Profile update failed: ' + error.message);
      }

      this.logger.log(`Profile updated: ${profileId}`);
      return { profile: data };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Update profile error: ${error.message}`);
      throw new BadRequestException('Failed to update profile');
    }
  }

  async getProfile(
    userId: string,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      const { data: profile, error: profileError } = await supabase
        .from('perfiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (profileError || !profile) {
        throw new NotFoundException('Profile not found');
      }

      const { data: prestador } = await supabase
        .from('perfiles_prestadores')
        .select('*')
        .eq('id', userId)
        .single();

      const { data: { user } } = await supabase.auth.getUser();

      return {
        id: profile.id,
        email: user?.email,
        nombre: profile.nombre,
        telefono: profile.telefono,
        rol: profile.rol,
        prestador_profile: this.mapPrestadorProfile(prestador),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Get profile error: ${error.message}`);
      throw new BadRequestException('Failed to fetch profile');
    }
  }

  async createOrUpdatePrestador(
    userId: string,
    createPrestadorDto: CreatePrestadorDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // First, verify the rubro exists
      const { data: rubro, error: rubroError } = await supabase
        .from('rubros')
        .select('id')
        .eq('id', createPrestadorDto.rubro_id)
        .single();

      if (rubroError || !rubro) {
        throw new BadRequestException('Invalid rubro_id');
      }

      // Check if prestador profile exists
      const { data: existing } = await supabase
        .from('perfiles_prestadores')
        .select('id')
        .eq('id', userId)
        .single();

      const prestadorData = {
        id: userId,
        rubro_id: createPrestadorDto.rubro_id,
        zona_nombre: createPrestadorDto.zona_nombre,
        esta_verificado: false,
        disponible: false,
      };

      let result;
      if (existing) {
        // Update existing
        const { data, error } = await supabase
          .from('perfiles_prestadores')
          .update(prestadorData)
          .eq('id', userId)
          .select('*')
          .single();

        if (error) {
          // Fallback if zona_nombre column does not exist in schema
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('perfiles_prestadores')
          .update({
            id: userId,
            rubro_id: createPrestadorDto.rubro_id,
              esta_verificado: false,
              disponible: false,
            })
            .eq('id', userId)
            .select('*')
            .single();

          if (fallbackError) {
            this.logger.error(`Prestador update failed: ${fallbackError.message}`);
            throw new BadRequestException('Failed to update prestador profile');
          }
          result = fallbackData;
        } else {
          result = data;
        }
      } else {
        // Create new
        const { data, error } = await supabase
          .from('perfiles_prestadores')
          .insert(prestadorData)
          .select('*')
          .single();

        if (error) {
          // Fallback if zona_nombre column does not exist in schema
          const { data: fallbackData, error: fallbackError } = await supabase
            .from('perfiles_prestadores')
            .insert({
              id: userId,
              rubro_id: createPrestadorDto.rubro_id,
              esta_verificado: false,
              disponible: false,
            })
            .select('*')
            .single();

          if (fallbackError) {
            this.logger.error(`Prestador creation failed: ${fallbackError.message}`);
            throw new BadRequestException('Failed to create prestador profile');
          }
          result = fallbackData;
        } else {
          result = data;
        }

        // Update role to prestador
        await supabase
          .from('perfiles')
          .update({ rol: 'prestador' })
          .eq('id', userId);
      }

      this.logger.log(`Prestador profile ${existing ? 'updated' : 'created'}: ${userId}`);
      return { prestador_profile: this.mapPrestadorProfile(result) };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Create/update prestador error: ${error.message}`);
      throw new BadRequestException('Failed to create/update prestador profile');
    }
  }

  async updateDisponibilidad(
    userId: string,
    dto: UpdateDisponibilidadDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      const { data: prestador, error: prestadorError } = await supabase
        .from('perfiles_prestadores')
        .update({ disponible: dto.disponible })
        .eq('id', userId)
        .select('*')
        .single();

      if (prestadorError || !prestador) {
        throw new BadRequestException('Failed to update availability');
      }

      return { prestador_profile: this.mapPrestadorProfile(prestador) };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Update disponibilidad error: ${error.message}`);
      throw new BadRequestException('Failed to update availability');
    }
  }

  async uploadCertificacion(
    userId: string,
    file: Express.Multer.File,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // Verify prestador profile exists
      const { data: prestador, error: prestadorError } = await supabase
        .from('perfiles_prestadores')
        .select('id')
        .eq('id', userId)
        .single();

      if (prestadorError || !prestador) {
        throw new BadRequestException('Prestador profile not found. Create prestador profile first.');
      }

      // Upload file to Supabase Storage
      const fileName = `${userId}_${Date.now()}_${file.originalname}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('certificaciones')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error(`File upload failed: ${uploadError.message}`);
        throw new BadRequestException('File upload failed: ' + uploadError.message);
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('certificaciones')
        .getPublicUrl(fileName);

      const publicUrl = urlData.publicUrl;

      // Update prestador profile with certification URL
      const { error: updateError } = await supabase
        .from('perfiles_prestadores')
        .update({ url_certificacion: publicUrl })
        .eq('id', userId);

      if (updateError) {
        this.logger.error(`Failed to update certification URL: ${updateError.message}`);
        throw new BadRequestException('Failed to save certification URL');
      }

      this.logger.log(`Certification uploaded: ${userId}`);
      return { certificacion_url: publicUrl };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Upload certification error: ${error.message}`);
      throw new BadRequestException('Failed to upload certification');
    }
  }
}
