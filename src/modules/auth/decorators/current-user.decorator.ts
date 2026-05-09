import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Mevcut oturumdaki kullanıcıyı döndüren decorator.
 * Kullanım: @CurrentUser() user
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
