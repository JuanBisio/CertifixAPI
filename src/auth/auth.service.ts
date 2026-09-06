import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ProfilesService } from '../profiles/profiles.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private supabaseService: SupabaseService,
    private profilesService: ProfilesService,
  ) {}

  async register(registerDto: RegisterDto) {
    const supabase = this.supabaseService.getClient();

    try {
      // Register user with Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: registerDto.email,
        password: registerDto.password,
      });

      if (authError) {
        this.logger.error(`Registration failed: ${authError.message}`);
        throw new BadRequestException(authError.message);
      }

      if (!authData.user) {
        throw new BadRequestException('User registration failed');
      }

      // Create profile in perfiles table. Usa el service client (no el cliente
      // recién autenticado por signUp) para no depender de que la sesión ya haya
      // propagado al momento del insert — necesario además una vez que `perfiles`
      // tenga RLS habilitado, ya que la policy de INSERT no cubre altas de perfil
      // ajenas al propio flujo de registro.
      const { error: profileError } = await this.supabaseService
        .getServiceClient()
        .from('perfiles')
        .insert({
          id: authData.user.id,
          nombre: registerDto.nombre,
          rol: null, // Default role; can be changed later
          created_at: new Date().toISOString(),
        });

      if (profileError) {
        this.logger.error(`Profile creation failed: ${profileError.message}`);
        // Note: User is created in auth but profile failed - this is a partial failure
        throw new BadRequestException(
          'Profile creation failed: ' + profileError.message,
        );
      }

      // Ensure we return a session/access_token (some Supabase projects may not return session on signUp)
      const { data: loginData, error: loginError } =
        await supabase.auth.signInWithPassword({
          email: registerDto.email,
          password: registerDto.password,
        });

      if (loginError) {
        this.logger.error(
          `Auto-login after register failed: ${loginError.message}`,
        );
        // If email confirmation is required, return a hint to the client
        if (loginError.message.toLowerCase().includes('email not confirmed')) {
          return {
            user: authData.user,
            requires_email_confirmation: true,
            session: authData.session || undefined,
            access_token: authData.session?.access_token,
          };
        }

        // Fall back to signUp data even if session missing
        return {
          user: authData.user,
          session: authData.session || undefined,
          access_token: authData.session?.access_token,
        };
      }

      this.logger.log(`User registered successfully: ${authData.user.id}`);

      return {
        user: loginData.user,
        session: loginData.session,
        access_token: loginData.session?.access_token,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Registration error: ${error.message}`);
      throw new BadRequestException('Registration failed');
    }
  }

  async login(loginDto: LoginDto) {
    const supabase = this.supabaseService.getClient();

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginDto.email,
        password: loginDto.password,
      });

      if (error) {
        this.logger.error(`Login failed: ${error.message}`);
        throw new UnauthorizedException('Invalid credentials');
      }

      if (!data.user || !data.session) {
        throw new UnauthorizedException('Login failed');
      }

      // Cuenta con eliminación solicitada (ver requestAccountDeletion): el
      // login queda bloqueado desde ese momento, no hay marcha atrás — se
      // invalida la sesión recién emitida antes de devolver el error.
      const { data: perfil } = await this.supabaseService
        .getServiceClient()
        .from('perfiles')
        .select('eliminacion_solicitada_at')
        .eq('id', data.user.id)
        .single();

      if (perfil?.eliminacion_solicitada_at) {
        await supabase.auth.signOut();
        this.logger.warn(
          `Login bloqueado, cuenta pendiente de eliminación: ${data.user.id}`,
        );
        throw new UnauthorizedException(
          'Esta cuenta fue dada de baja y está pendiente de eliminación',
        );
      }

      this.logger.log(`User logged in: ${data.user.id}`);

      return {
        user: data.user,
        session: data.session,
        access_token: data.session.access_token,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(`Login error: ${error.message}`);
      throw new UnauthorizedException('Login failed');
    }
  }

  async logout(accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      const { error } = await supabase.auth.signOut();

      if (error) {
        this.logger.error(`Logout failed: ${error.message}`);
        throw new BadRequestException('Logout failed');
      }

      this.logger.log('User logged out successfully');

      return { message: 'Logged out successfully' };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Logout error: ${error.message}`);
      throw new BadRequestException('Logout failed');
    }
  }

  async getCurrentUser(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    const serviceSupabase = this.supabaseService.getServiceClient();

    try {
      // Get user auth data using provided token
      const { data: authData, error: authError } =
        await supabase.auth.getUser(accessToken);
      if (authError) {
        this.logger.error(`Failed to fetch auth user: ${authError.message}`);
        throw new BadRequestException('Failed to fetch user data');
      }

      // Get profile from perfiles table
      const { data: profile, error: profileError } = await supabase
        .from('perfiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (profileError) {
        this.logger.error(`Failed to fetch profile: ${profileError.message}`);
        throw new BadRequestException('Failed to fetch user profile');
      }

      // Get prestador profile if exists
      const { data: prestadorProfile, error: prestadorError } =
        await serviceSupabase
          .from('perfiles_prestadores')
          .select('*')
          .eq('id', userId)
          .single();

      if (prestadorError) {
        this.logger.warn(
          `Prestador profile fetch error: ${prestadorError.message}`,
        );
      }
      this.logger.log(
        `getCurrentUser ${userId} rol=${profile.rol} prestador_profile=${prestadorProfile ? 'found' : 'none'}`,
      );

      return {
        id: profile.id,
        email: authData.user?.email,
        nombre: profile.nombre,
        telefono: profile.telefono,
        rol: profile.rol,
        strikes_count: profile.strikes_count,
        suspendido: profile.suspendido,
        prestador_profile:
          this.profilesService.mapPrestadorProfile(prestadorProfile),
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Get current user error: ${error.message}`);
      throw new BadRequestException('Failed to fetch user data');
    }
  }

  // Cumplimiento de privacidad V1 (T&C 2.6 / Política 14.2): eliminación
  // real de cuenta, autoservicio. Solo marca la solicitud y bloquea el
  // acceso — la supresión efectiva de datos corre a los 30 días vía
  // AccountDeletionCleanupService (src/profiles/account-deletion-cleanup.service.ts).
  async requestAccountDeletion(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: perfil, error: fetchError } = await supabase
      .from('perfiles')
      .select('eliminacion_solicitada_at')
      .eq('id', userId)
      .single();

    if (fetchError) {
      this.logger.error(
        `Failed to fetch perfil for account deletion: ${fetchError.message}`,
      );
      throw new BadRequestException(
        'No se pudo procesar la solicitud de eliminación',
      );
    }

    if (perfil?.eliminacion_solicitada_at) {
      throw new BadRequestException(
        'La eliminación de esta cuenta ya fue solicitada',
      );
    }

    const { error: updateError } = await supabase
      .from('perfiles')
      .update({ eliminacion_solicitada_at: new Date().toISOString() })
      .eq('id', userId);

    if (updateError) {
      this.logger.error(
        `Failed to mark account for deletion: ${updateError.message}`,
      );
      throw new BadRequestException(
        'No se pudo procesar la solicitud de eliminación',
      );
    }

    // Invalida todas las sesiones activas (todos los dispositivos), no solo
    // la que hizo este request — requiere el admin client (service role).
    const { error: signOutError } = await supabase.auth.admin.signOut(
      accessToken,
      'global',
    );
    if (signOutError) {
      this.logger.warn(
        `Failed to revoke sessions on account deletion: ${signOutError.message}`,
      );
    }

    this.logger.log(`Account deletion requested, sessions revoked: ${userId}`);

    return {
      message:
        'Tu cuenta va a ser eliminada. Tus datos personales se van a suprimir dentro de los próximos 30 días.',
    };
  }

  // Cambio de contraseña autoservicio (perfil → Configuración). Se re-valida
  // la contraseña actual con un signInWithPassword contra un cliente aparte
  // (no el autenticado por accessToken) antes de aplicar la nueva — evita que
  // alguien con una sesión ya abierta (token robado, dispositivo desbloqueado)
  // pueda cambiar la contraseña sin conocer la actual.
  async changePassword(
    email: string,
    accessToken: string,
    dto: ChangePasswordDto,
  ) {
    const supabase = this.supabaseService.getClient();

    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email,
      password: dto.current_password,
    });

    if (reauthError) {
      this.logger.warn(`Cambio de contraseña rechazado (email=${email}): contraseña actual incorrecta`);
      throw new UnauthorizedException('La contraseña actual es incorrecta');
    }

    const authedClient = this.supabaseService.getAuthenticatedClient(accessToken);
    const { error: updateError } = await authedClient.auth.updateUser({
      password: dto.new_password,
    });

    if (updateError) {
      this.logger.error(`Error al actualizar contraseña: ${updateError.message}`);
      throw new BadRequestException(
        updateError.message || 'No se pudo actualizar la contraseña',
      );
    }

    this.logger.log(`Contraseña actualizada (email=${email})`);
    return { message: 'Contraseña actualizada correctamente' };
  }
}
