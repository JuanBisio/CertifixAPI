import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
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

      // Create profile in perfiles table
      const { error: profileError } = await supabase
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
        throw new BadRequestException('Profile creation failed: ' + profileError.message);
      }

      // Ensure we return a session/access_token (some Supabase projects may not return session on signUp)
      const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
        email: registerDto.email,
        password: registerDto.password,
      });

      if (loginError) {
        this.logger.error(`Auto-login after register failed: ${loginError.message}`);
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
      const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
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
      const { data: prestadorProfile, error: prestadorError } = await serviceSupabase
        .from('perfiles_prestadores')
        .select('*')
        .eq('id', userId)
        .single();

      if (prestadorError) {
        this.logger.warn(`Prestador profile fetch error: ${prestadorError.message}`);
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
        prestador_profile: this.profilesService.mapPrestadorProfile(prestadorProfile),
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Get current user error: ${error.message}`);
      throw new BadRequestException('Failed to fetch user data');
    }
  }
}
