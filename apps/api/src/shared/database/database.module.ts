import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { Database } from './database.js';

@Module({})
export class DatabaseModule {
  public static register(databaseUrl: string): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: Database, useFactory: () => new Database(databaseUrl) }],
      exports: [Database],
    };
  }
}
