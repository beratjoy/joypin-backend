import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth('JWT')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Kullanıcı detayı' })
  @ApiResponse({ status: 200, description: 'Kullanıcı bilgileri' })
  @ApiResponse({ status: 404, description: 'Kullanıcı bulunamadı' })
  async findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }
}
