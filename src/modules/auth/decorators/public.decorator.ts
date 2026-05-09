import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Bu decorator ile işaretlenen route'lar JWT doğrulamasından muaf tutulur.
 * Kullanım: @Public()
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
