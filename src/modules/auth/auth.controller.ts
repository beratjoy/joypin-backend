import {
  Controller,
  Post,
  Body,
  Get,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly otpService: OtpService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Yeni kullanıcı kaydı' })
  @ApiResponse({ status: 201, description: 'Kullanıcı başarıyla oluşturuldu' })
  @ApiResponse({ status: 400, description: 'Geçersiz veri veya email zaten kayıtlı' })
  async register(
    @Body()
    body: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      phone?: string;
      referralCode?: string;
      countryCode?: string;
      preferredCurrency?: string;
    },
  ) {
    return this.authService.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Kullanıcı girişi — JWT token döner' })
  @ApiResponse({ status: 200, description: 'JWT access token' })
  @ApiResponse({ status: 401, description: 'Email veya şifre hatalı' })
  async login(@Body() body: { email: string; password: string; remember?: boolean; countryCode?: string; preferredCurrency?: string }) {
    return this.authService.login(body.email, body.password, Boolean(body.remember), {
      countryCode: body.countryCode,
      preferredCurrency: body.preferredCurrency,
    });
  }

  @Public()
  @Post('email/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'E-posta doğrulama kodunu yeniden gönder' })
  async resendEmailVerification(@Body() body: { email: string }) {
    return this.authService.resendEmailVerification(body.email);
  }

  @Public()
  @Post('email/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'E-posta doğrulama kodunu onayla' })
  async verifyEmail(@Body() body: { email: string; code: string }) {
    return this.authService.verifyEmail(body.email, body.code);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Şifre sıfırlama maili gönder' })
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Şifre sıfırlama tokenı ile yeni şifre belirle' })
  async resetPassword(@Body() body: { email: string; token: string; password: string }) {
    return this.authService.resetPassword(body.email, body.token, body.password);
  }

  @Get('me')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Giriş yapan kullanıcının profili' })
  @ApiResponse({ status: 200, description: 'Kullanıcı bilgileri' })
  async getMe(@CurrentUser() user: any) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      dealerGroup: user.dealerGroup,
      staffProfile: user.staffProfile ? {
        id: user.staffProfile.id,
        role: user.staffProfile.role,
        isActive: user.staffProfile.isActive,
        tenantIds: Array.isArray(user.staffProfile.tenantIds) ? user.staffProfile.tenantIds : [],
      } : null,
      allowedTenantIds: user.role === 'SUPER_ADMIN' ? [] : (Array.isArray(user.staffProfile?.tenantIds) ? user.staffProfile.tenantIds : []),
      countryCode: user.countryCode,
      preferredCurrency: user.preferredCurrency,
    };
  }

  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'OTP kodu gönder (SMS/Email)' })
  @ApiResponse({ status: 200, description: 'OTP gönderildi' })
  async sendOtp(@CurrentUser('id') userId: string) {
    return this.otpService.sendOtp(userId);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'OTP kodu doğrula' })
  @ApiResponse({ status: 200, description: 'OTP doğrulandı' })
  @ApiResponse({ status: 400, description: 'Geçersiz veya süresi dolmuş OTP' })
  async verifyOtp(
    @CurrentUser('id') userId: string,
    @Body('code') code: string,
  ) {
    return this.otpService.verifyOtp(userId, code);
  }
}
